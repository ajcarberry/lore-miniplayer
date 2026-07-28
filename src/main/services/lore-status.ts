import { lore } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import type { LoreFileStatus, LoreFileStatusGroup } from '../../shared/types';
import { isUnknownHash } from './branch-graph';
import { collectEvents } from './lore-events';

// Shared views over LoreFileStatusGroup's three arrays, so "every dirty file"
// and "what counts as dirty" are defined in one place for the merge/diff
// services.

// Every file the status scan reported, across all three groups. A path can
// appear in more than one group (e.g. staged AND unstaged) — callers that need
// distinct paths de-duplicate on top.
export function allStatusFiles(status: LoreFileStatusGroup): LoreFileStatus[] {
  return [...status.untracked, ...status.unstaged, ...status.staged];
}

// The distinct paths of every reported file (a path can carry both a staged
// and a dirty flag — count it once), keeping first-seen order.
export function distinctStatusPaths(status: LoreFileStatusGroup): string[] {
  return [...new Set(allStatusFiles(status).map(file => file.path))];
}

// A status row the SDK flags as part of a pending merge — the flagMerged
// bit, set on conflict rows AND on files the merge imported from the target
// (probed live 2026-07-27; a user's own row staged on top of a pending merge
// carries no flagMerged).
function isMergeFile(file: LoreFileStatus): boolean {
  return Boolean(file.merged);
}

// Staged rows the pending merge did NOT bring in: the user's own work, which
// must never ride a merge commit onto the target branch (the merge service's
// unrelated-staged guard) nor be destroyed by a merge abort's tree reset.
export function unrelatedStagedPaths(status: LoreFileStatusGroup): string[] {
  return status.staged.filter(file => !isMergeFile(file)).map(file => file.path);
}

// Landing ancestry: is this branch's work already on the target?

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

// The checkout's current branch and pending-merge marker — the two
// REPOSITORY_STATUS_REVISION fields the merge workflow's guards consume.
export interface WorkspaceRevisionStatus {
  readonly branchName: string;
  // Incoming revision of a pending merge, straight from the SDK; an unknown
  // hash (all zeros) means no merge is pending on disk.
  readonly revisionMerged: string;
}

// One cheap repositoryStatus({ revisionOnly: true }) call answering "what
// branch is checked out, and is a merge pending?" for the checkout's CURRENT
// branch. Undefined when the SDK streamed no revision event (callers
// degrade/fail closed). Failures are wrapped through `wrapError` (the owning
// service's operation-error context).
export async function readWorkspaceRevisionStatus(
  repositoryPath: string,
  wrapError: (error: unknown) => Error
): Promise<WorkspaceRevisionStatus | undefined> {
  const entries = await collectEvents(
    lore.repositoryStatus({ repositoryPath }, { revisionOnly: true }),
    LoreEventTag.REPOSITORY_STATUS_REVISION,
    data => ({
      branchName: data.branchName,
      revisionMerged: data.revisionMerged,
    }),
    wrapError
  );
  return entries[entries.length - 1];
}
