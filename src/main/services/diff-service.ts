import { lore, LoreError } from '@lore-vcs/sdk';
import type { LoreFluentApi } from '@lore-vcs/sdk';
import { LoreEventTag, LoreFileAction } from '@lore-vcs/sdk/types/enums';
import type {
  CompareTarget,
  DiffRequest,
  DiffResponse,
  FileDiffAction,
  FileDiffResult,
  LineStats,
} from '../../shared/types';
import { DiffRequestSchema } from '../../shared/schemas';
import { isUnknownHash } from './branch-graph';
import { collectEvents } from './lore-events';
import type { LoreEventDataOf } from './lore-events';

// Unified-diff patches over this many lines are stored/returned truncated
// (head only); 4000 lines comfortably covers any single file that is still
// reasonably reviewable as text in the review window's diff pane, while
// keeping the IPC payload bounded for pathological cases (generated files,
// lockfiles, etc.). lineStats is always computed from the FULL patch before
// truncation, since fileDiff returns the whole patch as one string (no
// streamed hunks) regardless of size.
export const PATCH_TRUNCATION_LINE_CAP = 4000;

export class DiffOperationError extends Error {
  constructor(
    message: string,
    public readonly errorType?: number
  ) {
    super(message);
    this.name = 'DiffOperationError';
  }
}

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

// No SDK primitive flags binary content directly (unverified against a live
// binary file — P1 did not probe this). `fileDiff` is documented to return
// unified-diff text (P1 finding a); a real content change always produces
// non-empty patch text, so an empty patch on a change that isn't a pure
// rename (MOVE with unchanged content, which legitimately diffs to nothing)
// is treated as binary content that couldn't be diffed as text.
function isBinaryChange(action: FileDiffAction, patch: string): boolean {
  return patch.length === 0 && action !== 'moved';
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

// Diffs a repository. Follows the fluent call + event.clone() + LoreError
// wrapping pattern established by lore-repository.ts and branch-graph.ts.
export class DiffService {
  private toOperationError(context: string, error: unknown): DiffOperationError {
    if (error instanceof DiffOperationError) {
      return error;
    }
    if (error instanceof LoreError) {
      const firstError = error.loreErrors?.[0];
      return new DiffOperationError(`${context}: ${error.message}`, firstError?.data.errorType);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new DiffOperationError(`${context}: ${message}`);
  }

  private collect<TTag extends LoreEventTag, T>(
    operation: LoreFluentApi,
    tag: TTag,
    map: (data: LoreEventDataOf<TTag>) => T | undefined,
    context: string
  ): Promise<T[]> {
    return collectEvents(operation, tag, map, error => this.toOperationError(context, error));
  }

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
        const infos = await this.collect(
          lore.branchInfo({ repositoryPath }, { branch: target.branch }),
          LoreEventTag.BRANCH_INFO,
          (data: LoreEventDataOf<LoreEventTag.BRANCH_INFO>) => data.latest,
          `Failed to resolve branch '${target.branch}'`
        );
        const latest = infos[infos.length - 1];
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
    const raw = await this.collect(
      lore.fileDiff(
        { repositoryPath },
        { sourceRevision, targetRevision, ...(paths ? { paths } : {}) }
      ),
      LoreEventTag.FILE_DIFF,
      (data: LoreEventDataOf<LoreEventTag.FILE_DIFF>) => ({
        path: data.path,
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
    const { repositoryPath, source, target, paths } = DiffRequestSchema.parse(request);
    const [sourceRevision, targetRevision] = await Promise.all([
      this.resolveRevision(repositoryPath, source),
      this.resolveRevision(repositoryPath, target),
    ]);
    return this.diffRevisions(repositoryPath, sourceRevision, targetRevision, paths);
  }

  // Branch-vs-parent overview (Mission Control card file stats, P9): uses
  // the dedicated branchDiff op to enumerate the files that actually
  // changed on `branchName` since it diverged from its parent, then fetches
  // each file's patch via fileDiff scoped to just those paths between the
  // two branches' tips. Returns [] for a root branch (no parent, e.g. main)
  // or when nothing has changed, without calling branchDiff/fileDiff.
  async branchVsParent(repositoryPath: string, branchName: string): Promise<FileDiffResult[]> {
    const parentName = await this.resolveParentBranchName(repositoryPath, branchName);
    if (!parentName) {
      return [];
    }

    const changedPaths = await this.collect(
      lore.branchDiff({ repositoryPath }, { source: parentName, target: branchName }),
      LoreEventTag.BRANCH_DIFF_CHANGE,
      (data: LoreEventDataOf<LoreEventTag.BRANCH_DIFF_CHANGE>) => data.change.path,
      `Failed to diff branch '${branchName}' against its parent`
    );
    if (changedPaths.length === 0) {
      return [];
    }

    const [sourceRevision, targetRevision] = await Promise.all([
      this.resolveRevision(repositoryPath, { kind: 'branchHead', branch: parentName }),
      this.resolveRevision(repositoryPath, { kind: 'branchHead', branch: branchName }),
    ]);
    return this.diffRevisions(repositoryPath, sourceRevision, targetRevision, changedPaths);
  }

  // Resolves a branch's parent BRANCH NAME (branchDiff's args take names,
  // not ids) via branchInfo's parent id + a branchList id->name lookup,
  // mirroring branch-graph.ts's parent resolution. Returns null for a
  // branch with no parent (an all-zero/empty id, e.g. main).
  private async resolveParentBranchName(
    repositoryPath: string,
    branchName: string
  ): Promise<string | null> {
    const infos = await this.collect(
      lore.branchInfo({ repositoryPath }, { branch: branchName }),
      LoreEventTag.BRANCH_INFO,
      (data: LoreEventDataOf<LoreEventTag.BRANCH_INFO>) => data.parent,
      `Failed to resolve the parent of branch '${branchName}'`
    );
    const parentId = infos[infos.length - 1];
    if (!parentId || isUnknownHash(parentId)) {
      return null;
    }

    const entries = await this.collect(
      lore.branchList({ repositoryPath }, {}),
      LoreEventTag.BRANCH_LIST_ENTRY,
      (data: LoreEventDataOf<LoreEventTag.BRANCH_LIST_ENTRY>) => ({ id: data.id, name: data.name }),
      'Failed to list branches'
    );
    return entries.find(entry => entry.id === parentId)?.name ?? null;
  }
}
