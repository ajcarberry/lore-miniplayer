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

// A status row the SDK flags as part of a pending merge, whether it conflicted,
// was resolved, or automerged. NOT every file the merge touched: a file the
// TARGET added which the source branch never had is staged by the merge with
// every one of these flags false (`{isUntracked: true, isStaged:
// true, conflict*: false}`), which is why the merge service also carries the
// paths its own merge staged (see unrelatedStagedPaths).
export function isMergeFile(file: LoreFileStatus): boolean {
  return Boolean(
    file.conflict ||
    file.conflictUnresolved ||
    file.conflictAutomerged ||
    file.conflictMine ||
    file.conflictTheirs
  );
}

// The repo-relative paths staged in a status group.
export function stagedPaths(status: LoreFileStatusGroup): Set<string> {
  return new Set(status.staged.map(file => file.path));
}

// Staged rows that neither carry a merge flag nor were staged by the merge
// itself (`imported`): the user's own work, which must never ride a merge
// commit onto the target branch (the merge service's A3-dirty guard).
export function unrelatedStagedPaths(
  status: LoreFileStatusGroup,
  imported: ReadonlySet<string>
): string[] {
  return status.staged
    .filter(file => !isMergeFile(file) && !imported.has(file.path))
    .map(file => file.path);
}

// --- landing ancestry (is this branch's work already on the target?) --------

// How far back the target branch's lineage is walked when deciding whether the
// source branch has revisions the target lacks. Bounded work; a branch that
// diverged more than this many revisions back has plenty to land regardless.
const LANDING_HISTORY_WALK_LENGTH = 100;

// A branch's local and remote tips, straight from BRANCH_INFO.
async function readBranchTips(
  repositoryPath: string,
  branch: string,
  wrapError: (error: unknown) => Error
): Promise<{ latest: string; latestRemote: string } | undefined> {
  const entries = await collectEvents(
    lore.branchInfo({ repositoryPath }, { branch }),
    LoreEventTag.BRANCH_INFO,
    data => ({ latest: data.latest ?? '', latestRemote: data.latestRemote ?? '' }),
    wrapError
  );
  return entries[entries.length - 1];
}

// The revision a merge toward `branch` actually addresses: the branch's REMOTE
// tip. BRANCH_INFO's `latest` is the LOCAL store's tip, which for a branch that
// isn't checked out lags whatever another client pushed — and a landing through
// `branchMergeInto` advances the remote tip WITHOUT advancing the local one
// so the local tip is stale even for this app's own landings.
// Falls back to `latest` when there is no known remote revision (a branch that
// has never been pushed).
export async function readMergeTargetRevision(
  repositoryPath: string,
  branch: string,
  wrapError: (error: unknown) => Error
): Promise<string> {
  const tips = await readBranchTips(repositoryPath, branch, wrapError);
  if (!tips) {
    return '';
  }
  return tips.latestRemote && !isUnknownHash(tips.latestRemote) ? tips.latestRemote : tips.latest;
}

// Every revision the target branch's history holds, INCLUDING the revisions its
// merge commits brought in (each entry's second parent). revisionHistory walks
// FIRST parents only, so a branch that landed through a merge commit appears
// nowhere as an entry of its own — only as that commit's second parent. Reading
// the walk as revisions alone is why an already-landed branch kept being
// offered for merge.
async function readTargetHistory(
  repositoryPath: string,
  revision: string,
  wrapError: (error: unknown) => Error
): Promise<Set<string>> {
  const entries = await collectEvents(
    lore.revisionHistory({ repositoryPath }, { revision, length: LANDING_HISTORY_WALK_LENGTH }),
    LoreEventTag.REVISION_HISTORY_ENTRY,
    data => ({ revision: data.revision, merged: data.parent[1] }),
    wrapError
  );
  const history = new Set<string>();
  for (const entry of entries) {
    history.add(entry.revision);
    if (entry.merged && !isUnknownHash(entry.merged)) {
      history.add(entry.merged);
    }
  }
  return history;
}

// Whether the source branch carries revisions the target lacks — the "would
// merging this branch land anything?" question. Answered by ANCESTRY rather
// than by the merge's file rows: merging the target into the branch produces no
// rows when the target hasn't moved, yet the branch's own commits still need to
// land; and a branch whose tip is already in the target's history (in-app OR
// merged by another client) has genuinely nothing to merge.
export async function readHasRevisionsToLand(
  repositoryPath: string,
  sourceBranch: string,
  targetBranch: string,
  wrapError: (error: unknown) => Error
): Promise<boolean> {
  const [sourceTips, targetRevision] = await Promise.all([
    readBranchTips(repositoryPath, sourceBranch, wrapError),
    readMergeTargetRevision(repositoryPath, targetBranch, wrapError),
  ]);
  const sourceTip = sourceTips?.latest ?? '';
  if (!sourceTip || isUnknownHash(sourceTip)) {
    return false;
  }
  if (sourceTip === targetRevision) {
    return false;
  }
  if (!targetRevision || isUnknownHash(targetRevision)) {
    // A target with no readable tip holds nothing, so the branch's own work is
    // unlanded by definition.
    return true;
  }
  const history = await readTargetHistory(repositoryPath, targetRevision, wrapError);
  return !history.has(sourceTip);
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
