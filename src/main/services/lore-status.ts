import { lore } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import type { BranchDivergence, LoreFileStatus, LoreFileStatusGroup } from '../../shared/types';
import { isUnknownHash } from './branch-graph';
import { collectEvents } from './lore-events';

// Shared views over LoreFileStatusGroup's three arrays, so "every dirty file"
// and "what counts as dirty" are defined in one place (used by the merge/diff
// services, the workspace model's banding, and the teardown guard).

// Every file the status scan reported, across all three groups. A path can
// appear in more than one group (e.g. staged AND unstaged) — callers that need
// distinct paths de-duplicate on top.
export function allStatusFiles(status: LoreFileStatusGroup): LoreFileStatus[] {
  return [...status.untracked, ...status.unstaged, ...status.staged];
}

// A working tree with anything untracked, unstaged, or staged is dirty.
export function isDirty(status: LoreFileStatusGroup): boolean {
  return status.untracked.length + status.unstaged.length + status.staged.length > 0;
}

// Any reported file carrying a conflict flag.
export function hasConflict(status: LoreFileStatusGroup): boolean {
  return allStatusFiles(status).some(file => file.conflict);
}

// The current checkout's branch, revision, and remote divergence — everything
// one repositoryStatus({ revisionOnly: true }) event carries (see
// readWorkspaceRevisionStatus).
export interface WorkspaceRevisionStatus {
  readonly branchName: string;
  readonly revision: string;
  readonly divergence: BranchDivergence;
}

// Divergence state straight from REPOSITORY_STATUS_REVISION's ahead flags —
// the SDK-computed equivalent of lore-repository's deriveDivergence history
// walk, valid for the checkout's CURRENT branch. Unknown hashes fail closed
// to 'unknown' (matching deriveDivergence); differing tips without a provable
// local-only lead read as behindOrDiverged.
function deriveDivergenceFromFlags(info: {
  latest: string;
  latestRemote: string;
  isLocalAhead: boolean;
  isRemoteAhead: boolean;
}): BranchDivergence['state'] {
  if (isUnknownHash(info.latest) || isUnknownHash(info.latestRemote)) {
    return 'unknown';
  }
  if (info.latest === info.latestRemote) {
    return 'inSync';
  }
  return info.isLocalAhead && !info.isRemoteAhead ? 'ahead' : 'behindOrDiverged';
}

// One cheap repositoryStatus({ revisionOnly: true }) call: the checkout's
// current branch + revision plus the SDK's native ahead/behind divergence —
// replacing a branchInfo + bounded history walk for consumers that only ever
// ask about the checkout's current branch (workspace cards, the teardown
// guard, the anchor). Undefined when the SDK streamed no revision event
// (callers degrade/fail closed). Failures are wrapped through `wrapError`
// (the owning service's operation-error context).
export async function readWorkspaceRevisionStatus(
  repositoryPath: string,
  wrapError: (error: unknown) => Error
): Promise<WorkspaceRevisionStatus | undefined> {
  const entries = await collectEvents(
    lore.repositoryStatus({ repositoryPath }, { revisionOnly: true }),
    LoreEventTag.REPOSITORY_STATUS_REVISION,
    data => ({
      branchName: data.branchName,
      revision: data.revision,
      latest: data.revisionLocal,
      latestRemote: data.revisionRemote,
      isLocalAhead: Boolean(data.isLocalAhead),
      isRemoteAhead: Boolean(data.isRemoteAhead),
    }),
    wrapError
  );
  const info = entries[entries.length - 1];
  if (!info) {
    return undefined;
  }
  return {
    branchName: info.branchName,
    revision: info.revision,
    divergence: {
      state: deriveDivergenceFromFlags(info),
      latest: info.latest,
      latestRemote: info.latestRemote,
    },
  };
}
