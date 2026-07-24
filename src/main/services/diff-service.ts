import { lore } from '@lore-vcs/sdk';
import { LoreEventTag, LoreFileAction } from '@lore-vcs/sdk/types/enums';
import type {
  CompareTarget,
  DiffRequest,
  DiffResponse,
  FileDiffAction,
  FileDiffResult,
  LineStats,
  LoreFileStatusGroup,
} from '../../shared/types';
import { isUnknownHash } from './branch-graph';
import type { LoreEventDataOf } from './lore-events';
import {
  OperationError,
  branchTip,
  operationHelpers,
  toRepoAbsolutePath,
  toRepoRelativePath,
} from './lore-operation';
import { allStatusFiles } from './lore-status';

// Unified-diff patches over this many lines are stored/returned truncated
// (head only); 4000 lines comfortably covers any single file that is still
// reasonably reviewable as text in the review window's diff pane, while
// keeping the IPC payload bounded for pathological cases (generated files,
// lockfiles, etc.). lineStats is always computed from the FULL patch before
// truncation, since fileDiff returns the whole patch as one string (no
// streamed hunks) regardless of size.
export const PATCH_TRUNCATION_LINE_CAP = 4000;

export class DiffOperationError extends OperationError {
  constructor(message: string, errorType?: number) {
    super(message, errorType);
    this.name = 'DiffOperationError';
  }
}

// Shared collect scaffold (see ./lore-operation), typed to this service's
// error class.
const ops = operationHelpers(DiffOperationError);
const { collect } = ops;

// Maps a Lore file action to the FileDiffResult schema's action vocabulary.
// KEEP (no path change) is a content-only edit, i.e. 'modified'. COPY has no
// dedicated schema value — the compare picker doesn't distinguish a copy
// from a fresh addition at the new path, so it maps to 'added'.
function toFileDiffAction(action: LoreFileAction): FileDiffAction {
  switch (action) {
    case LoreFileAction.ADD:
      return 'added';
    case LoreFileAction.DELETE:
      return 'deleted';
    case LoreFileAction.MOVE:
      return 'moved';
    case LoreFileAction.COPY:
      return 'added';
    case LoreFileAction.KEEP:
    default:
      return 'modified';
  }
}

// Unified-diff line counting: a leading '+' that isn't the '+++' file
// header is an added line; a leading '-' that isn't the '---' header is a
// removed line. Hunk headers ('@@ ... @@') and context lines are ignored.
export function computeLineStats(patch: string): LineStats {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }
  return { added, removed };
}

// The SDK emits a literal `Binary files differ` sentinel as the patch for a
// binary content change (probed against a live binary file — P1 Findings (i)),
// NOT unified-diff text and NOT an empty patch. That sentinel is the primary
// binary signal. The empty-patch guard is retained as a secondary heuristic
// for a non-move change that diffs to nothing (a pure rename, MOVE with
// unchanged content, legitimately diffs to empty and is NOT binary).
const BINARY_DIFF_SENTINEL = 'Binary files differ';

function isBinaryChange(action: FileDiffAction, patch: string): boolean {
  return patch.startsWith(BINARY_DIFF_SENTINEL) || (patch.length === 0 && action !== 'moved');
}

// Truncates a patch over the line cap, keeping only its head.
function truncatePatch(patch: string): { patch: string; truncated: boolean } {
  const lines = patch.split('\n');
  if (lines.length <= PATCH_TRUNCATION_LINE_CAP) {
    return { patch, truncated: false };
  }
  return { patch: lines.slice(0, PATCH_TRUNCATION_LINE_CAP).join('\n'), truncated: true };
}

function toFileDiffResult(data: {
  path: string;
  patch: string;
  action: LoreFileAction;
}): FileDiffResult {
  const action = toFileDiffAction(data.action);
  if (isBinaryChange(action, data.patch)) {
    return { path: data.path, action, binary: true, truncated: false };
  }
  const lineStats = computeLineStats(data.patch);
  const { patch, truncated } = truncatePatch(data.patch);
  return { path: data.path, action, patch, binary: false, truncated, lineStats };
}

// The status + revision surface `workspaceDirtyStats` reuses (LoreRepository
// service provides both). Kept a narrow structural interface so tests inject a
// lightweight fake and the workspace-dirty path never re-parses repository
// status itself.
export interface DiffRepositorySource {
  getFileStatus(repositoryPath: string): Promise<LoreFileStatusGroup>;
  getCurrentRevision(repositoryPath: string): Promise<string>;
}

// Diffs a repository. Follows the fluent call + event.clone() + LoreError
// wrapping pattern established by lore-repository.ts and branch-graph.ts.
export class DiffService {
  constructor(private readonly repository: DiffRepositorySource) {}

  // Resolves a compare-picker target to the revision string `fileDiff`
  // takes: a literal revision, '' for the working tree (P1 finding a —
  // omitting the revision compares the source against uncommitted edits),
  // or a branch's tip resolved via branchInfo.
  private async resolveRevision(repositoryPath: string, target: CompareTarget): Promise<string> {
    switch (target.kind) {
      case 'revision':
        return target.revision;
      case 'workingTree':
        return '';
      case 'branchHead': {
        const latest = await branchTip(
          ops,
          repositoryPath,
          target.branch,
          `Failed to resolve branch '${target.branch}'`
        );
        if (!latest) {
          throw new DiffOperationError(`Branch '${target.branch}' has no known revision`);
        }
        return latest;
      }
    }
  }

  private async diffRevisions(
    repositoryPath: string,
    sourceRevision: string,
    targetRevision: string,
    paths?: string[]
  ): Promise<FileDiffResult[]> {
    // The SDK needs repo-absolute paths in, and echoes them back out — the
    // app works repo-relative on both sides (see toRepoAbsolutePath).
    const absolutePaths = paths?.map(p => toRepoAbsolutePath(repositoryPath, p));
    const raw = await collect(
      lore.fileDiff(
        { repositoryPath },
        { sourceRevision, targetRevision, ...(absolutePaths ? { paths: absolutePaths } : {}) }
      ),
      LoreEventTag.FILE_DIFF,
      (data: LoreEventDataOf<LoreEventTag.FILE_DIFF>) => ({
        path: toRepoRelativePath(repositoryPath, data.path),
        patch: data.patch,
        action: data.action,
      }),
      'Failed to diff files'
    );
    return raw.map(toFileDiffResult);
  }

  // The review window's compare picker (design 2b): resolves both
  // CompareTarget sides to revisions and diffs them with fileDiff. The
  // working-tree side never needs the fileDump fallback (P1 finding a).
  async compare(request: DiffRequest): Promise<DiffResponse> {
    // Validated at the IPC boundary (validators.ts); typed in-process here.
    const { repositoryPath, source, target, paths } = request;
    const [sourceRevision, targetRevision] = await Promise.all([
      this.resolveRevision(repositoryPath, source),
      this.resolveRevision(repositoryPath, target),
    ]);
    const diffs = await this.diffRevisions(repositoryPath, sourceRevision, targetRevision, paths);
    // An unfiltered compare against the WORKING TREE (the review window's commit
    // workflow) must list every file the status scan reports dirty, so the
    // reviewer can stage/commit it and the list matches the scan-driven Mission
    // Control card exactly. `fileDiff(source -> working tree)` OMITS a dirty file
    // whose working tree matches the source revision — e.g. a change staged, then
    // reverted on disk: the scan still flags it dirty (staged), but there is no
    // working-tree delta to enumerate. Backfill those as zero-delta entries so
    // the list is a superset of (in the common case, equal to) the dirty set.
    // Skipped for a non-working-tree target (revision->revision has no dirty set)
    // and for a path-filtered compare (the caller asked for a specific subset).
    if (target.kind === 'workingTree' && !paths) {
      return this.backfillDirtySet(repositoryPath, diffs);
    }
    return diffs;
  }

  // Appends any status-scan dirty file the working-tree diff did not enumerate
  // (see `compare`), as a zero-delta entry — mirrors `workspaceDirtyStats`'
  // scan-driven list so the review window and the card never disagree.
  private async backfillDirtySet(
    repositoryPath: string,
    diffs: FileDiffResult[]
  ): Promise<FileDiffResult[]> {
    const status = await this.repository.getFileStatus(repositoryPath);
    const dirtyPaths = dedupePaths(allStatusFiles(status));
    const enumerated = new Set(diffs.map(diff => diff.path));
    const untracked = new Set(status.untracked.map(file => file.path));
    const missing = dirtyPaths
      .filter(dirtyPath => !enumerated.has(dirtyPath))
      .map(dirtyPath => cleanWorkingTreeEntry(dirtyPath, untracked.has(dirtyPath)));
    return missing.length > 0 ? [...diffs, ...missing] : diffs;
  }

  // Workspace change overview (Mission Control card file stats, P9): exactly the
  // DIRTY files — what `lore status --scan` identifies (untracked / unstaged /
  // staged), with committed-since-fork work deliberately EXCLUDED (that is
  // represented separately by the card's "Session commits"). The file LIST is
  // the status scan's dirty set (authoritative for the count — one entry per
  // dirty file, so changedFileCount equals the scan's dirty count exactly); each
  // file's lineStats come from a fileDiff of the current revision against the
  // WORKING TREE (empty target — P1 Findings (a)/(i)) filtered to the dirty
  // paths. Edge cases (P1 Findings (i)): an untracked add yields an all-plus
  // patch (action ADD), a delete yields an all-minus patch (action DELETE, no
  // error), a binary change yields the `Binary files differ` sentinel (flagged
  // binary, excluded from line counts but still one file). A dirty file the
  // diff does not enumerate (e.g. staged but the working tree matches the
  // current revision) still counts, with zero line stats. Returns [] when the
  // working tree is clean.
  async workspaceDirtyStats(repositoryPath: string): Promise<FileDiffResult[]> {
    const status = await this.repository.getFileStatus(repositoryPath);
    const dirtyPaths = dedupePaths(allStatusFiles(status));
    if (dirtyPaths.length === 0) {
      return [];
    }
    const currentRevision = await this.repository.getCurrentRevision(repositoryPath);
    const byPath = new Map<string, FileDiffResult>();
    if (currentRevision && !isUnknownHash(currentRevision)) {
      const diffs = await this.diffRevisions(repositoryPath, currentRevision, '', dirtyPaths);
      for (const diff of diffs) {
        byPath.set(diff.path, diff);
      }
    }
    const untracked = new Set(status.untracked.map(file => file.path));
    return dirtyPaths.map(
      dirtyPath =>
        byPath.get(dirtyPath) ?? cleanWorkingTreeEntry(dirtyPath, untracked.has(dirtyPath))
    );
  }
}

// De-duplicates status entries to distinct paths (a path can carry both a
// staged and a dirty flag — count it once, P1 Findings (i) edge (c)), keeping
// first-seen order.
function dedupePaths(files: ReadonlyArray<{ path: string }>): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const file of files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      paths.push(file.path);
    }
  }
  return paths;
}

// A dirty file the current-revision -> working-tree diff did not enumerate
// (its working tree matches the current revision, e.g. a staged change later
// reverted on disk): still counted as a changed file, with no line delta in
// this diff direction.
function cleanWorkingTreeEntry(path: string, isUntracked: boolean): FileDiffResult {
  return {
    path,
    action: isUntracked ? 'added' : 'modified',
    binary: false,
    truncated: false,
    lineStats: { added: 0, removed: 0 },
  };
}
