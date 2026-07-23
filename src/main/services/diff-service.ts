import * as path from 'node:path';
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

  // The SDK resolves a relative path arg against the process CWD, NOT
  // globalArgs.repositoryPath (known gotcha, first hit on fileStage — see
  // lore-handlers.ts / merge-service.ts). A repo-relative path such as
  // 'Content/Caves/pass_1.txt' would otherwise become
  // '<app-cwd>/Content/Caves/pass_1.txt' and fileDiff rejects it as an
  // invalid path. Every path handed to an SDK op must be repo-absolute.
  // Idempotent for a path that is already absolute.
  private toAbsolutePath(repositoryPath: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(repositoryPath, filePath);
  }

  // fileDiff echoes back the (now absolute) path it was queried with, but the
  // app/UI works only in repo-relative paths — strip the repository prefix on
  // the way out. Idempotent for a path that is already relative.
  private toRepoRelativePath(repositoryPath: string, filePath: string): string {
    return path.isAbsolute(filePath) ? path.relative(repositoryPath, filePath) : filePath;
  }

  private async diffRevisions(
    repositoryPath: string,
    sourceRevision: string,
    targetRevision: string,
    paths?: string[]
  ): Promise<FileDiffResult[]> {
    const absolutePaths = paths?.map(p => this.toAbsolutePath(repositoryPath, p));
    const raw = await this.collect(
      lore.fileDiff(
        { repositoryPath },
        { sourceRevision, targetRevision, ...(absolutePaths ? { paths: absolutePaths } : {}) }
      ),
      LoreEventTag.FILE_DIFF,
      (data: LoreEventDataOf<LoreEventTag.FILE_DIFF>) => ({
        path: this.toRepoRelativePath(repositoryPath, data.path),
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

  // Workspace change overview (Mission Control card file stats, P9): the files
  // this workspace has changed relative to where its branch forked from its
  // parent, INCLUDING uncommitted working-tree edits. Diffs the fork point
  // (branchInfo.branchPoint) against the WORKING TREE (empty target — P1
  // finding a/h) with no path filter, so both committed branch commits and
  // uncommitted edits count, and parent commits made AFTER the fork never leak
  // in as reversed deletions (the earlier parent-tip -> branch-tip approach
  // both zeroed uncommitted-only workspaces and mis-signed post-fork parent
  // changes — P1 finding h). A root branch (no fork point, e.g. main) falls
  // back to its own tip, surfacing working-tree-only changes. Returns [] when
  // no base resolves or nothing has changed.
  async branchVsParent(repositoryPath: string, branchName: string): Promise<FileDiffResult[]> {
    const base = await this.resolveWorkspaceBase(repositoryPath, branchName);
    if (!base) {
      return [];
    }
    return this.diffRevisions(repositoryPath, base, '');
  }

  // The revision the card diff is measured FROM: the branch's fork point
  // (branchInfo.branchPoint) when it has a parent, else the branch's own local
  // tip for a root branch (yielding working-tree-only changes). Null when
  // neither is a known (non-zero) revision.
  private async resolveWorkspaceBase(
    repositoryPath: string,
    branchName: string
  ): Promise<string | null> {
    const infos = await this.collect(
      lore.branchInfo({ repositoryPath }, { branch: branchName }),
      LoreEventTag.BRANCH_INFO,
      (data: LoreEventDataOf<LoreEventTag.BRANCH_INFO>) => ({
        branchPoint: data.branchPoint,
        latest: data.latest,
      }),
      `Failed to resolve the base of branch '${branchName}'`
    );
    const info = infos[infos.length - 1];
    if (!info) {
      return null;
    }
    if (!isUnknownHash(info.branchPoint)) {
      return info.branchPoint;
    }
    if (!isUnknownHash(info.latest)) {
      return info.latest;
    }
    return null;
  }
}
