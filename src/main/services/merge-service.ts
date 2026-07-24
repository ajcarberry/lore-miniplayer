import { lore, LoreError } from '@lore-vcs/sdk';
import type { LoreFluentApi } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import * as path from 'node:path';
import type { MainLogger } from '../ipc/logger';
import type { LoreRepositoryService } from './lore-repository';
import { collectEvents } from './lore-events';
import type { LoreEventDataOf } from './lore-events';
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
import {
  MergeStartRequestSchema,
  MergeResolveRequestSchema,
  MergeAbortRequestSchema,
  MergeCompleteRequestSchema,
} from '../../shared/schemas';

export class MergeOperationError extends Error {
  constructor(
    message: string,
    public readonly errorType?: number
  ) {
    super(message);
    this.name = 'MergeOperationError';
  }
}

// How far back each branch's lineage is walked when deciding whether the source
// branch has revisions the target lacks. Mirrors lore-repository's divergence
// walk cap: bounded work, and a branch that diverged more than this many
// revisions back has plenty to land regardless.
const MERGE_HISTORY_WALK_LENGTH = 100;

// The state retained per in-flight merge so resolve/complete can rebuild the
// MergeState across IPC calls without re-driving the merge: which branches are
// involved and the conflicted paths reported by branchMergeStart (the
// BRANCH_MERGE_CONFLICT_FILE events are path-only, P1e — the file's current
// resolution is re-read from status each time).
interface ActiveMerge {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly conflictPaths: readonly string[];
  // Whether the source branch has revisions the target lacks — captured once at
  // start(). Distinguishes a clean phase-1 update with the branch still ahead
  // ("ready to land") from a branch whose tip is already on the target
  // ("nothing to merge"). Resolving conflicts never changes this.
  readonly hasChangesToLand: boolean;
  // Set once the resolved merge is committed on the workspace branch (phase 1
  // of complete()). If a subsequent landing step fails, this lets a retry skip
  // re-committing — the workspace merge-commit is already durable.
  committedRevision?: string;
}

// Drives the "Integrate" stage (design 2c): merge the workspace's branch
// toward main, expose conflicts for accept-mine/accept-theirs resolution, and
// land the merge with a commit + push.
//
// Merge-flow decision (Start vs Into): this runs `branchMergeStart` from the
// workspace checkout — whose current branch IS the source (feature) branch —
// merging the TARGET branch (main) INTO it. This is the path P1 actually
// probed (finding e), which verified the on-disk conflict materialization,
// per-file resolve semantics, and abort-restores behavior. It also aligns the
// design's labels: P1e established that for branchMergeStart, "ours"/mine =
// the current branch and "theirs" = the branch merged in — so mine = the
// feature branch and theirs = main, exactly as design 2c shows ("accept mine
// (branch) / accept theirs (main @ rN)"). The merge is started with noCommit so
// completion controls the commit.
//
// Landing on the target (design 2c: "merge commits land on main"). The started
// merge only puts the target's changes INTO the workspace branch; to advance
// the target, complete() (1) commits the resolved merge on the workspace branch,
// then (2) lands it on the target. `branchMergeInto` toward the target is the
// truer fit but is unavailable offline — probed `06-mergeinto`: it throws
// "Invalid branch latest revision", and `branchReset` toward the merge-commit is
// rejected as off-branch (P1e-addendum). What provably lands (probe `06c`,
// approach A): switch the checkout to the target, `branchMergeStart` the source
// branch into it — CLEAN, since the source branch now already contains the
// target's changes — commit (this commit is the landed revision, target tip
// advances), restore the checkout to the source branch, then push the target
// branch. A landing failure leaves the workspace merge-commit intact and is
// reported; the recorded commit makes a retry skip re-committing.
//
// Exposing both sides for the UI: P2's MergeState/MergeFileState carry no
// content fields (path/state/resolution only) and the shared schema is out of
// this packet's scope, so mine/theirs CONTENT is not read from the `~mine`/
// `~theirs` sidecars here — the review window fetches each side through the
// existing diff channel (diff:compare) with branchHead compare targets. The
// conflict file list in MergeState tells it which paths to diff.
//
// Only one merge may be in flight per repository; a concurrent start is a
// typed error. All state transitions are logged.
export class MergeService {
  private readonly activeMerges = new Map<string, ActiveMerge>();

  constructor(
    private readonly log: MainLogger,
    private readonly loreRepositoryService: LoreRepositoryService
  ) {}

  // Start a merge: merge the target branch into the workspace checkout (which
  // holds the source branch). Collects the conflicted paths, records the
  // in-flight merge, and returns the composed MergeState. Refuses a second
  // concurrent merge for the same repository.
  async start(request: MergeStartRequest): Promise<MergeState> {
    const { repositoryPath, sourceBranch, targetBranch } = MergeStartRequestSchema.parse(request);

    if (this.activeMerges.has(repositoryPath)) {
      throw new MergeOperationError(
        `A merge is already in progress for repository '${repositoryPath}'`
      );
    }

    this.log.info('Merge start', {
      operation: 'merge:start',
      repositoryPath,
      sourceBranch,
      targetBranch,
    });

    const conflictPaths = await this.collect(
      lore.branchMergeStart({ repositoryPath }, { branch: targetBranch, noCommit: true }),
      LoreEventTag.BRANCH_MERGE_CONFLICT_FILE,
      (data: LoreEventDataOf<LoreEventTag.BRANCH_MERGE_CONFLICT_FILE>) => data.path,
      `Failed to start merge of '${targetBranch}' into '${sourceBranch}'`
    );

    // The merge is now materialized on disk but not yet recorded. If the
    // ahead-of-target computation fails, back the merge out before rethrowing —
    // otherwise the checkout is stranded mid-merge with no in-flight record:
    // resolve/abort/complete would all refuse ("no merge in progress") and a
    // retried start would re-run branchMergeStart on an already-merging repo.
    let hasChangesToLand: boolean;
    try {
      hasChangesToLand = await this.sourceHasRevisionsToLand(
        repositoryPath,
        sourceBranch,
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
      throw error;
    }

    const record: ActiveMerge = { sourceBranch, targetBranch, conflictPaths, hasChangesToLand };
    this.activeMerges.set(repositoryPath, record);
    return this.buildMergeState(repositoryPath, record);
  }

  // Resolve a single conflicted file as mine (the workspace/feature branch) or
  // theirs (the target/main branch). Re-runnable to switch a file's side —
  // there is no separate unresolve step in the v1 flow. Refuses a path that is
  // not a conflict in the current merge, or a repository with no active merge.
  async resolve(request: MergeResolveRequest): Promise<MergeState> {
    const { repositoryPath, path: filePath, resolution } = MergeResolveRequestSchema.parse(request);

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
    // unresolved (P1e-addendum, probe 06b). The conflict path from
    // BRANCH_MERGE_CONFLICT_FILE is repo-relative, so join it here.
    const absPath = path.join(repositoryPath, filePath);
    const op =
      resolution === 'mine'
        ? lore.branchMergeResolveMine({ repositoryPath }, { paths: [absPath] })
        : lore.branchMergeResolveTheirs({ repositoryPath }, { paths: [absPath] });
    await this.run(op, `Failed to resolve '${filePath}' as ${resolution}`);

    return this.buildMergeState(repositoryPath, record);
  }

  // Abort an in-flight merge, restoring the checkout's pre-merge content (P1e)
  // and clearing the in-flight record so a new merge may be started.
  async abort(request: MergeAbortRequest): Promise<MergeAbortResponse> {
    const { repositoryPath } = MergeAbortRequestSchema.parse(request);
    this.requireActiveMerge(repositoryPath);

    this.log.info('Merge abort', { operation: 'merge:abort', repositoryPath });
    await this.run(lore.branchMergeAbort({ repositoryPath }, {}), 'Failed to abort merge');

    this.activeMerges.delete(repositoryPath);
    return { aborted: true };
  }

  // Complete an in-flight merge and land it on the target branch. Two phases:
  // (1) commit the resolved merge on the workspace (source) branch — refused
  // while any conflict is unresolved, durable once done; (2) land that commit
  // on the target branch (see landOnTarget). A landing failure surfaces a typed
  // error that reports the intact workspace merge-commit; the record is kept so
  // a retry skips re-committing. Clears the record and returns the target's
  // landed revision on success.
  async complete(request: MergeCompleteRequest): Promise<MergeCompleteResponse> {
    const { repositoryPath } = MergeCompleteRequestSchema.parse(request);
    const record = this.requireActiveMerge(repositoryPath);

    // Phase 1: commit the resolved merge on the workspace (source) branch.
    if (!record.committedRevision) {
      const state = await this.buildMergeState(repositoryPath, record);
      if (!state.allResolved) {
        throw new MergeOperationError(
          'Cannot complete the merge while conflicts remain unresolved'
        );
      }
      const sourceMessage = `Merge branch '${record.targetBranch}' into '${record.sourceBranch}'`;
      this.log.info('Merge complete: committing on workspace branch', {
        operation: 'merge:complete',
        repositoryPath,
        message: sourceMessage,
      });
      await this.loreRepositoryService.commit(repositoryPath, sourceMessage);
      record.committedRevision =
        await this.loreRepositoryService.getCurrentRevision(repositoryPath);
    }

    // Phase 2: land the workspace merge-commit on the target branch.
    let landedRevision: string;
    try {
      landedRevision = await this.landOnTarget(repositoryPath, record);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MergeOperationError(
        `Merge committed on '${record.sourceBranch}' (${record.committedRevision}) but failed to land on '${record.targetBranch}': ${detail}`,
        error instanceof MergeOperationError ? error.errorType : undefined
      );
    }

    this.activeMerges.delete(repositoryPath);
    return { revision: landedRevision };
  }

  // --- internals ------------------------------------------------------------

  // Land the workspace branch's merge-commit on the target branch (P1e-addendum
  // approach A — branchMergeInto is unavailable offline). Switches the checkout
  // to the target, re-merges the source branch into it (CLEAN: the source now
  // contains the target's changes), commits — that commit is the landed
  // revision — pushes the target branch, and always restores the checkout to
  // the source branch. Returns the landed revision on the target.
  private async landOnTarget(repositoryPath: string, record: ActiveMerge): Promise<string> {
    this.log.info('Merge complete: landing on target branch', {
      operation: 'merge:complete',
      repositoryPath,
      targetBranch: record.targetBranch,
    });

    await this.loreRepositoryService.switchBranch(repositoryPath, record.targetBranch);
    try {
      const conflictFlags = await this.collect(
        lore.branchMergeStart({ repositoryPath }, { branch: record.sourceBranch, noCommit: true }),
        LoreEventTag.BRANCH_MERGE_START_END,
        (data: LoreEventDataOf<LoreEventTag.BRANCH_MERGE_START_END>) => Boolean(data.hasConflicts),
        `Failed to land '${record.sourceBranch}' on '${record.targetBranch}'`
      );
      if (conflictFlags.some(Boolean)) {
        // Never expected (the source already contains the target); back out
        // the target-side merge so the checkout is left clean before restoring.
        await this.run(
          lore.branchMergeAbort({ repositoryPath }, {}),
          'Failed to abort unexpected landing conflict'
        );
        throw new MergeOperationError(
          `Unexpected conflict landing '${record.sourceBranch}' on '${record.targetBranch}'`
        );
      }

      const targetMessage = `Merge branch '${record.sourceBranch}' into '${record.targetBranch}'`;
      let landedRevision: string;
      try {
        await this.loreRepositoryService.commit(repositoryPath, targetMessage);
        landedRevision = await this.loreRepositoryService.getCurrentRevision(repositoryPath);
      } catch (error) {
        // The target checkout may still hold the pending noCommit merge; back
        // it out before the finally restores the source branch — otherwise the
        // target is left mid-merge and a retried complete() wedges on the
        // landing branchMergeStart.
        this.log.error('Merge complete: landing failed; backing out the target-side merge', {
          error,
          operation: 'merge:complete',
          repositoryPath,
          targetBranch: record.targetBranch,
        });
        await this.abortMergeQuietly(
          repositoryPath,
          'Failed to back out the target-side merge after a landing failure'
        );
        throw error;
      }
      await this.run(
        lore.branchPush({ repositoryPath }, { branch: record.targetBranch }),
        `Failed to push '${record.targetBranch}'`
      );
      return landedRevision;
    } finally {
      // Always restore the workspace checkout to the source branch.
      await this.loreRepositoryService.switchBranch(repositoryPath, record.sourceBranch);
    }
  }

  // Best-effort branchMergeAbort for failure paths: backs out an on-disk merge
  // so the failed operation leaves the checkout clean. An abort failure is
  // logged but never masks the original error being rethrown by the caller.
  private async abortMergeQuietly(repositoryPath: string, context: string): Promise<void> {
    try {
      await this.run(lore.branchMergeAbort({ repositoryPath }, {}), context);
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
  // 'merged' rows (P1e), each recorded conflict path becomes a 'conflict' row
  // whose resolution is derived from its status flags (mine/theirs, or none
  // when still unresolved). allResolved is true when every conflict has a side.
  private async buildMergeState(repositoryPath: string, record: ActiveMerge): Promise<MergeState> {
    const status = await this.loreRepositoryService.getFileStatus(repositoryPath);
    const statusByPath = new Map<string, LoreFileStatus>();
    for (const file of [...status.untracked, ...status.unstaged, ...status.staged]) {
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
      files,
      allResolved,
      hasChangesToLand: record.hasChangesToLand,
    };
  }

  // Whether the source branch has revisions the target lacks — the "would this
  // merge land anything?" question the file rows can't answer. A clean phase-1
  // update (branchMergeStart of the target into the branch) produces no rows
  // when the target hasn't moved since the branch diverged, yet the branch's
  // own commits still need to land (P1-repro 07); conversely a branch whose tip
  // is already the target's has genuinely nothing to merge.
  //
  // Computed by lineage diff rather than branchDiff: branchDiff is a CONTENT
  // diff and reports nothing when the target hasn't moved (P1-repro 07), so it
  // cannot see the branch's commits. Each branch tip comes from branchInfo
  // (`latest`) and its lineage is walked by revision hash — the `branch` arg of
  // revisionHistory is a dead end for the non-current target branch (see
  // branch-graph.ts). Any revision on the source lineage absent from the
  // target's means the branch is ahead.
  private async sourceHasRevisionsToLand(
    repositoryPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<boolean> {
    const [sourceTip, targetTip] = await Promise.all([
      this.branchTip(repositoryPath, sourceBranch),
      this.branchTip(repositoryPath, targetBranch),
    ]);
    if (!sourceTip) {
      return false;
    }
    if (sourceTip === targetTip) {
      return false;
    }
    const [sourceLineage, targetLineage] = await Promise.all([
      this.walkLineage(repositoryPath, sourceTip),
      targetTip ? this.walkLineage(repositoryPath, targetTip) : Promise.resolve([]),
    ]);
    const targetRevisions = new Set(targetLineage);
    return sourceLineage.some(revision => !targetRevisions.has(revision));
  }

  // The latest revision hash of a branch (its tip), or '' when unavailable.
  private async branchTip(repositoryPath: string, branch: string): Promise<string> {
    const infos = await this.collect(
      lore.branchInfo({ repositoryPath }, { branch }),
      LoreEventTag.BRANCH_INFO,
      (data: LoreEventDataOf<LoreEventTag.BRANCH_INFO>) => data.latest,
      `Failed to read the tip of branch '${branch}'`
    );
    return infos[infos.length - 1] ?? '';
  }

  // Walk a branch lineage backward from a revision hash (newest-first), returning
  // the revision hashes, capped at MERGE_HISTORY_WALK_LENGTH.
  private async walkLineage(repositoryPath: string, revision: string): Promise<string[]> {
    return this.collect(
      lore.revisionHistory({ repositoryPath }, { revision, length: MERGE_HISTORY_WALK_LENGTH }),
      LoreEventTag.REVISION_HISTORY_ENTRY,
      (data: LoreEventDataOf<LoreEventTag.REVISION_HISTORY_ENTRY>) => data.revision,
      `Failed to walk revision lineage from '${revision}'`
    );
  }

  private async run(operation: LoreFluentApi, context: string): Promise<void> {
    try {
      await operation.waitAsync();
    } catch (error) {
      throw this.toOperationError(context, error);
    }
  }

  private async collect<TTag extends LoreEventTag, T>(
    operation: LoreFluentApi,
    tag: TTag,
    map: (data: LoreEventDataOf<TTag>) => T | undefined,
    context: string
  ): Promise<T[]> {
    return collectEvents(operation, tag, map, error => this.toOperationError(context, error));
  }

  private toOperationError(context: string, error: unknown): MergeOperationError {
    if (error instanceof MergeOperationError) {
      return error;
    }
    if (error instanceof LoreError) {
      const firstError = error.loreErrors?.[0];
      return new MergeOperationError(`${context}: ${error.message}`, firstError?.data.errorType);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new MergeOperationError(`${context}: ${message}`);
  }
}
