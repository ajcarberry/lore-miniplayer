import type { RepositoryNotification } from '../../shared/types';

// Formats the card-top attribution toast (design 1c: "user-42 pushed r128
// to feature/act-two") from a repository notification plus whatever local
// context is known. `userId` is shown raw — no name-resolution IPC exists,
// by scope choice. branchPushed carries no branch/revision of its own (P2's
// schema — only userId), so the caller supplies the currently-displayed
// branch and the branch's current tip revision number as the best-effort
// stand-in; when the tip isn't known yet the sentence drops the revision
// rather than fabricate one. branchCreated/branchDeleted are not
// attributable (no userId) and return null — nothing to toast.
export function formatAttributionMessage(
  notification: RepositoryNotification,
  branchName: string,
  revisionNumber: number | undefined
): string | null {
  const who = notification.userId ?? 'Someone';

  if (notification.kind === 'branchPushed') {
    return revisionNumber !== undefined
      ? `${who} pushed r${revisionNumber} to ${branchName}`
      : `${who} pushed to ${branchName}`;
  }

  return null;
}
