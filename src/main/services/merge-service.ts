import { lore } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import type { MainLogger } from '../ipc/logger';
import type { LoreRepositoryService } from './lore-repository';
import type { LoreEventDataOf } from './lore-events';
import { OperationError, operationHelpers, toRepoAbsolutePath } from './lore-operation';
import { allStatusFiles, isMergeFile, stagedPaths, unrelatedStagedPaths } from './lore-status';
import type {
  LoreFileStatus,
  MergeAbortRequest,
  MergeAbortResponse,
  MergeCompleteRequest,
  MergeCompleteResponse,
  MergeFileState,
  MergeResolveRequest,
  MergeStartRequest,
  MergeState,
} from '../../shared/types';

export class MergeOperationError extends OperationError {
  constructor(message: string) {
    super(message);
    this.name = 'MergeOperationError';
  }
}

// Internal marker for the one landing failure that is not retryable: the target
// branch moved after the source branch merged it in, which `branchMergeInto`
// refuses outright ("Target branch to merge into has a newer revision").
// complete() turns it into the user-facing typed error and discards the merge,
// since retrying it would refuse forever — the recovery is a fresh merge over
// the new target.
class TargetAdvancedError extends Error {}

// How the SDK words that refusal; the only landing failure worth recognising.
const TARGET_ADVANCED_PATTERN = /newer revision/i;

// How the SDK words "there is no merge to abort" — a tolerated no-op, not a
// failure (see abortOnDisk).
const NO_MERGE_PATTERN = /no merge is in progress/i;

// Shared run/collect scaffold (see ./lore-operation), typed to this service's
// error class.
const { run, collect, toOperationError } = operationHelpers(MergeOperationError);

// The state retained per in-flight merge so resolve/complete can rebuild the
// MergeState across IPC calls without re-driving the merge: which branches are
// involved and the conflicted paths reported by branchMergeStart (the
// BRANCH_MERGE_CONFLICT_FILE events are path-only — the file's current
// resolution is re-read from status each time).
interface ActiveMerge {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly conflictPaths: readonly string[];
  // The target-branch revision this merge brought in — its REMOTE tip (see
  // readMergeTargetRevision).
  readonly targetRevision: string;
  // Whether the source branch has revisions the target lacks — captured once at
  // start(). Distinguishes a clean phase-1 update with the branch still ahead
  // ("ready to land") from a branch whose tip is already on the target
  // ("nothing to merge"). Resolving conflicts never changes this.
  readonly hasChangesToLand: boolean;
  // Everything the merge itself staged, including the target-added files the
  // SDK stages with no merge flag at all (see isMergeFile). The start pre-flight
  // guarantees the checkout had nothing staged beforehand, so anything staged
  // AFTER this set is the user's own work for the unrelated-staged guard.
  readonly importedPaths: ReadonlySet<string>;
  // Set once the resolved merge is committed on the source branch (phase 1
  // of complete()). If a subsequent landing step fails, this lets a retry skip
  // re-committing — the source-branch merge-commit is already durable.
  committedRevision?: string;
}

// The Project View's merge workflow: merge the checkout's branch toward the
// target, expose conflicts for accept-mine/accept-theirs resolution, and land
// the merge on the target branch.
//
// Merge flow: `branchMergeStart` runs from the checkout — whose current
// branch IS the source branch — merging the TARGET branch INTO it. For
// branchMergeStart, "ours"/mine = the current branch and "theirs" = the
// branch merged in. The merge starts with noCommit so completion controls the
// commit.
//
// Landing: the started merge only puts the target's changes INTO the source
// branch; to advance the target, complete() (1) commits the resolved merge on
// the source branch, then (2) lands it with `branchMergeInto` toward the
// target. Against a live server that single call commits the merge on the
// target AND publishes it (no follow-up push), leaves the checkout on the
// source branch, and leaves the working tree clean. It is atomic: a refused
// landing advances nothing, locally or remotely, so a retry simply lands.
// `branchMergeInto` requires a live server ("Invalid branch latest revision"
// offline). The LOCAL tip of the target branch does not move, only its remote
// tip — anything asking "is this branch landed?" must read the remote tip
// (see lore-status).
//
// Exposing both sides for the UI: MergeState/MergeFileState carry no content
// fields (path/state/resolution only), so mine/theirs content is not read
// from the `~mine`/`~theirs` sidecars here — the Project View fetches each
// side through the diff channel (diff:compare). The conflict file list in
// MergeState tells it which paths to diff.
//
// Only one merge may be in flight per repository; a concurrent start is a
// typed error. All state transitions are logged.
export class MergeService {
  private readonly activeMerges = new Map<string, ActiveMerge>();
  // Repositories with a start() past its in-flight check but not yet
  // recorded — closes the gap where two overlapping starts both pass it.
  private readonly startingRepos = new Set<string>();

  constructor(
    private readonly log: MainLogger,
    private readonly loreRepositoryService: LoreRepositoryService
  ) {}

  // Start a merge: merge the target branch into the checkout (which
  // holds the source branch). Collects the conflicted paths, records the
  // in-flight merge, and returns the composed MergeState. Refuses a second
  // concurrent merge for the same repository.
  async start(request: MergeStartRequest): Promise<MergeState> {
    const { repositoryPath } = request;
    if (this.activeMerges.has(repositoryPath) || this.startingRepos.has(repositoryPath)) {
      throw new MergeOperationError(
        `A merge is already in progress for repository '${repositoryPath}'`
      );
    }
    this.startingRepos.add(repositoryPath);
    try {
      return await this.runStart(request);
    } finally {
      this.startingRepos.delete(repositoryPath);
    }
  }

  private async runStart(request: MergeStartRequest): Promise<MergeState> {
    // Validated at the IPC boundary (validators.ts); typed in-process here.
    const { repositoryPath, sourceBranch, targetBranch } = request;

    this.log.info('Merge start', {
      operation: 'merge:start',
      repositoryPath,
      sourceBranch,
      targetBranch,
    });

    // The request names the branch the caller BELIEVES is checked out. If
    // the checkout has since moved (the user switched by hand), merging the
    // target in would resolve "mine" against the wrong branch — refuse before
    // anything is materialized on disk.
    await this.verifyCheckoutBranch(repositoryPath, sourceBranch);
    // Everything branchMergeStart refuses to start on top of, checked (and
    // where possible cleared) BEFORE it runs, so the user never meets the raw
    // "Cannot merge with staged state".
    await this.requireMergeableCheckout(repositoryPath);

    const conflictPaths = await collect(
      lore.branchMergeStart({ repositoryPath }, { branch: targetBranch, noCommit: true }),
      LoreEventTag.BRANCH_MERGE_CONFLICT_FILE,
      (data: LoreEventDataOf<LoreEventTag.BRANCH_MERGE_CONFLICT_FILE>) => data.path,
      `Failed to start merge of '${targetBranch}' into '${sourceBranch}'`
    );

    // The merge is now materialized on disk but not yet recorded. If either
    // branch read below fails, back the merge out before rethrowing — otherwise
    // the checkout is stranded mid-merge with no in-flight record:
    // resolve/abort/complete would all refuse ("no merge in progress") and a
    // retried start would re-run branchMergeStart on an already-merging repo.
    let hasChangesToLand: boolean;
    let targetRevision: string;
    let importedPaths: ReadonlySet<string>;
    try {
      // The pre-flight guarantees nothing was staged before the merge ran, so
      // everything staged now is the merge's own import — including the
      // target-added files the SDK stages with no merge flag at all.
      importedPaths = stagedPaths(await this.loreRepositoryService.getFileStatus(repositoryPath));
      hasChangesToLand = await this.loreRepositoryService.hasRevisionsToLand(
        repositoryPath,
        sourceBranch,
        targetBranch
      );
      targetRevision = await this.loreRepositoryService.getMergeTargetRevision(
        repositoryPath,
        targetBranch
      );
    } catch (error) {
      this.log.error('Merge start failed after branchMergeStart; backing out the on-disk merge', {
        error,
        operation: 'merge:start',
        repositoryPath,
      });
      await this.abortMergeQuietly(
        repositoryPath,
        'Failed to back out the merge after a start failure'
      );
      throw toOperationError(
        `Failed to start merge of '${targetBranch}' into '${sourceBranch}'`,
        error
      );
    }

    const record: ActiveMerge = {
      sourceBranch,
      targetBranch,
      targetRevision,
      conflictPaths,
      hasChangesToLand,
      importedPaths,
    };
    this.rememberMerge(repositoryPath, record);
    return this.buildMergeState(repositoryPath, record);
  }

  // Resolve a single conflicted file as mine (the source branch) or
  // theirs (the target/main branch). Re-runnable to switch a file's side —
  // there is no separate unresolve step in the v1 flow. Refuses a path that is
  // not a conflict in the current merge, or a repository with no active merge.
  async resolve(request: MergeResolveRequest): Promise<MergeState> {
    const { repositoryPath, path: filePath, resolution } = request;

    const record = this.requireActiveMerge(repositoryPath);
    if (!record.conflictPaths.includes(filePath)) {
      throw new MergeOperationError(`'${filePath}' is not a conflicted file in the current merge`);
    }

    this.log.info('Merge resolve', {
      operation: 'merge:resolve',
      repositoryPath,
      path: filePath,
      resolution,
    });

    // The resolve ops address files by their repo-ABSOLUTE path: a
    // repo-relative path is PATH_IGNOREd and silently leaves the file
    // unresolved (see toRepoAbsolutePath). The
    // conflict path from BRANCH_MERGE_CONFLICT_FILE is repo-relative.
    const absPath = toRepoAbsolutePath(repositoryPath, filePath);
    const op =
      resolution === 'mine'
        ? lore.branchMergeResolveMine({ repositoryPath }, { paths: [absPath] })
        : lore.branchMergeResolveTheirs({ repositoryPath }, { paths: [absPath] });
    await run(op, `Failed to resolve '${filePath}' as ${resolution}`);

    return this.buildMergeState(repositoryPath, record);
  }

  // Abort a merge, restoring the checkout's pre-merge content and
  // clearing the in-flight record so a new merge may be started. Deliberately
  // tolerant: the merge workflow offers Abort from its start-ERROR state, where
  // by definition no merge was ever recorded, and an on-disk merge can outlive
  // the record (app restart, closed window). So it aborts whatever is on disk
  // and reports whether there was anything to abort — aborting nothing is a
  // logged no-op, never an error the user has to decipher.
  async abort(request: MergeAbortRequest): Promise<MergeAbortResponse> {
    const { repositoryPath } = request;
    this.log.info('Merge abort', {
      operation: 'merge:abort',
      repositoryPath,
      inFlight: this.activeMerges.has(repositoryPath),
    });

    const aborted = await this.abortOnDisk(repositoryPath, 'Failed to abort merge');
    this.forgetMerge(repositoryPath);
    return { aborted };
  }

  // Complete an in-flight merge and land it on the target branch. Two phases:
  // (1) commit the resolved merge on the source branch — refused
  // while any conflict is unresolved, durable once done; (2) land that commit
  // on the target branch (see landOnTarget). A landing failure surfaces a typed
  // error that reports the intact source-branch merge-commit; the record is kept so
  // a retry skips re-committing. Clears the record and returns the target's
  // landed revision on success.
  async complete(request: MergeCompleteRequest): Promise<MergeCompleteResponse> {
    const { repositoryPath } = request;
    const record = this.requireActiveMerge(repositoryPath);

    // Both commits below sweep in whatever is staged, so unrelated
    // staged work would silently ride the merge onto the target branch.
    await this.refuseUnrelatedStagedWork(repositoryPath, record);

    // Phase 1: commit the resolved merge on the source branch.
    if (!record.committedRevision) {
      const state = await this.buildMergeState(repositoryPath, record);
      if (!state.allResolved) {
        throw new MergeOperationError(
          'Cannot complete the merge while conflicts remain unresolved'
        );
      }
      const sourceMessage = `Merge branch '${record.targetBranch}' into '${record.sourceBranch}'`;
      this.log.info('Merge complete: committing on source branch', {
        operation: 'merge:complete',
        repositoryPath,
        message: sourceMessage,
      });
      // The commit op itself streams the committed revision — no follow-up
      // history read.
      record.committedRevision = await this.loreRepositoryService.commit(
        repositoryPath,
        sourceMessage
      );
    }

    // Phase 2: land the source-branch merge-commit on the target branch.
    let landedRevision: string;
    try {
      landedRevision = await this.landOnTarget(repositoryPath, record);
    } catch (error) {
      if (error instanceof TargetAdvancedError) {
        // The reviewed merge is stale: the target moved after the source
        // branch merged it in. Retrying would conflict forever, so drop the
        // merge — the source-branch merge-commit stays, and a fresh start() merges
        // the new target content.
        this.forgetMerge(repositoryPath);
        throw new MergeOperationError(
          `'${record.targetBranch}' advanced since this merge started, so the reviewed merge no longer applies. ` +
            `The merge commit on '${record.sourceBranch}' (${record.committedRevision}) is intact — ` +
            `start the merge again to bring in the new '${record.targetBranch}' changes.`
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new MergeOperationError(
        `Merge committed on '${record.sourceBranch}' (${record.committedRevision}) but failed to land on '${record.targetBranch}': ${detail}`
      );
    }

    this.forgetMerge(repositoryPath);
    return { revision: landedRevision };
  }

  // --- internals ------------------------------------------------------------

  // Land the source branch's merge-commit on the target branch: one
  // `branchMergeInto` from the source checkout, which commits the merge on the
  // target and publishes it to the server in the same call (the
  // checkout never leaves its own branch and the working tree stays clean).
  // Returns the landed revision, streamed by the operation itself. A refusal
  // lands nothing at all, so the caller's error is the whole story.
  private async landOnTarget(repositoryPath: string, record: ActiveMerge): Promise<string> {
    this.log.info('Merge complete: landing on target branch', {
      operation: 'merge:complete',
      repositoryPath,
      targetBranch: record.targetBranch,
    });

    const context = `Failed to land '${record.sourceBranch}' on '${record.targetBranch}'`;
    let revisions: string[];
    try {
      revisions = await collect(
        lore.branchMergeInto(
          { repositoryPath },
          {
            branch: record.targetBranch,
            message: `Merge branch '${record.sourceBranch}' into '${record.targetBranch}'`,
          }
        ),
        LoreEventTag.BRANCH_MERGE_INTO_REVISION,
        (data: LoreEventDataOf<LoreEventTag.BRANCH_MERGE_INTO_REVISION>) => data.revision,
        context
      );
    } catch (error) {
      // The target moved after the source branch merged it in: the SDK refuses
      // rather than conflicting, and nothing has changed on either branch.
      if (error instanceof Error && TARGET_ADVANCED_PATTERN.test(error.message)) {
        throw new TargetAdvancedError(error.message);
      }
      throw error;
    }

    const landedRevision = revisions[revisions.length - 1];
    if (!landedRevision) {
      throw new MergeOperationError(`${context}: the merge reported no landed revision`);
    }
    return landedRevision;
  }

  // Checkout guard: the checkout's current branch must be the request's source
  // branch. An unreadable status degrades to "no answer" rather than blocking
  // the merge — the checks that follow still protect the on-disk state.
  private async verifyCheckoutBranch(repositoryPath: string, sourceBranch: string): Promise<void> {
    const status = await this.loreRepositoryService.getWorkspaceRevisionStatus(repositoryPath);
    if (status && status.branchName !== sourceBranch) {
      throw new MergeOperationError(
        `Cannot merge into '${sourceBranch}': the checkout at '${repositoryPath}' is on '${status.branchName}'`
      );
    }
  }

  // Pre-flight for branchMergeStart, which refuses ANY staged state with the
  // opaque "Cannot merge with staged state". Two very different situations
  // reach it:
  //
  // A merge left materialized on disk by a previous session — the app
  // restarted, or the Project View exited before its abort ran. Its rows may
  // carry merge flags (a conflict) or, for a clean merge that only imported
  // target-only files, no flag at all — just staged rows. Either shape is
  // backed out and the merge re-run: the user asked for this merge, and
  // re-running reproduces it against the current target.
  //
  // Anything still dirty after that is the user's own work — not ours to
  // discard, so the merge is refused by NAME, with the action that clears it.
  private async requireMergeableCheckout(repositoryPath: string): Promise<void> {
    let status = await this.loreRepositoryService.getFileStatus(repositoryPath);
    if (allStatusFiles(status).some(isMergeFile) || status.staged.length > 0) {
      this.log.warn('Merge start: backing out a merge left on disk by a previous session', {
        operation: 'merge:start',
        repositoryPath,
      });
      if (await this.abortOnDisk(repositoryPath, 'Failed to discard the stale merge')) {
        status = await this.loreRepositoryService.getFileStatus(repositoryPath);
      }
    }

    // ANY uncommitted work blocks the merge, not just staged files: every
    // abort path (explicit, failure back-outs, stale-merge cleanup) resets
    // the working tree wholesale — unstaged edits revert and untracked files
    // are deleted.
    const dirty = [...new Set(allStatusFiles(status).map(file => file.path))].sort();
    if (dirty.length > 0) {
      throw new MergeOperationError(
        `Cannot start the merge with uncommitted changes in '${repositoryPath}': ${dirty.join(', ')}. ` +
          'Commit or revert them first — aborting a merge resets the working tree and would discard them.'
      );
    }
  }

  // branchMergeAbort, tolerating "there was no merge to abort" as the no-op it
  // is: reports whether a merge was actually backed out, and only a real
  // failure throws.
  private async abortOnDisk(repositoryPath: string, context: string): Promise<boolean> {
    try {
      await run(lore.branchMergeAbort({ repositoryPath }, {}), context);
      return true;
    } catch (error) {
      if (error instanceof Error && NO_MERGE_PATTERN.test(error.message)) {
        this.log.info('Merge abort: nothing to abort on disk', {
          operation: 'merge:abort',
          repositoryPath,
        });
        return false;
      }
      throw error;
    }
  }

  // Unrelated-staged guard: staged files that the merge did not bring in would be swept
  // into the merge commit (and from there onto the target branch). "The merge
  // brought it in" means either a merge-flagged row or one of the paths the
  // merge staged at start() — the target-added files the SDK leaves unflagged.
  private async refuseUnrelatedStagedWork(
    repositoryPath: string,
    record: ActiveMerge
  ): Promise<void> {
    const status = await this.loreRepositoryService.getFileStatus(repositoryPath);
    const unrelated = unrelatedStagedPaths(status, record.importedPaths);
    if (unrelated.length > 0) {
      throw new MergeOperationError(
        `Cannot complete the merge while unrelated staged changes are present: ${unrelated.join(', ')}. ` +
          'Unstage them (or commit them separately) and retry.'
      );
    }
  }

  private rememberMerge(repositoryPath: string, record: ActiveMerge): void {
    this.activeMerges.set(repositoryPath, record);
  }

  private forgetMerge(repositoryPath: string): void {
    this.activeMerges.delete(repositoryPath);
  }

  // Best-effort backout for failure paths: leaves the checkout clean after a
  // failed operation. An abort failure is logged but never masks the original
  // error being rethrown by the caller.
  private async abortMergeQuietly(repositoryPath: string, context: string): Promise<void> {
    try {
      await this.abortOnDisk(repositoryPath, context);
    } catch (abortError) {
      this.log.error(context, {
        error: abortError,
        operation: 'merge:abort',
        repositoryPath,
      });
    }
  }

  private requireActiveMerge(repositoryPath: string): ActiveMerge {
    const record = this.activeMerges.get(repositoryPath);
    if (!record) {
      throw new MergeOperationError(`No merge is in progress for repository '${repositoryPath}'`);
    }
    return record;
  }

  // Composes the MergeState from the recorded branches/conflict paths and a
  // fresh working-directory status read: automerged files become inert
  // 'merged' rows, each recorded conflict path becomes a 'conflict' row
  // whose resolution is derived from its status flags (mine/theirs, or none
  // when still unresolved). allResolved is true when every conflict has a side.
  private async buildMergeState(repositoryPath: string, record: ActiveMerge): Promise<MergeState> {
    const status = await this.loreRepositoryService.getFileStatus(repositoryPath);
    const statusByPath = new Map<string, LoreFileStatus>();
    for (const file of allStatusFiles(status)) {
      statusByPath.set(file.path, file);
    }

    const conflictSet = new Set(record.conflictPaths);
    const files: MergeFileState[] = [];

    for (const [path, file] of statusByPath) {
      if (file.conflictAutomerged && !conflictSet.has(path)) {
        files.push({ path, state: 'merged' });
      }
    }

    for (const path of record.conflictPaths) {
      const file = statusByPath.get(path);
      const resolution = file?.conflictMine ? 'mine' : file?.conflictTheirs ? 'theirs' : undefined;
      files.push({ path, state: 'conflict', ...(resolution ? { resolution } : {}) });
    }

    const allResolved = record.conflictPaths.every(path => {
      const file = statusByPath.get(path);
      return Boolean(file?.conflictMine || file?.conflictTheirs);
    });

    return {
      sourceBranch: record.sourceBranch,
      targetBranch: record.targetBranch,
      targetRevision: record.targetRevision,
      files,
      allResolved,
      hasChangesToLand: record.hasChangesToLand,
    };
  }
}
