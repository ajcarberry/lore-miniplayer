import { useCallback } from 'react';
import type { BranchGraph, RepositoryNotification } from '../../shared/types';
import { computeAgentAttention } from '../utils/agentAttention';
import { formatAttributionMessage } from '../utils/attributionToast';
import { useAttributionToasts } from './useAttributionToasts';
import { useMissionControlSnapshot } from './useMissionControlSnapshot';
import { useResolvedUserName } from './useResolvedUserName';

// Field names deliberately mirror Pill/PlayerCard's own chip/toast/conflict
// props (needsYouCount, activeCount, onOpenMissionControl, toast,
// onDismissToast, conflictRevisionNumber) so callers can wire them with a
// single `{...agentAttention}` spread instead of restating each one.
export interface AgentAttentionState {
  readonly needsYouCount: number;
  readonly activeCount: number;
  // needsYouCount > 0 — the notice-pulse trigger for MiniPlayer's
  // setNoticeActive wiring (an agent workspace needing you pulses the pill
  // exactly like a pending sync).
  readonly hasAttention: boolean;
  // The formatted toast to show at the card's top, or null when the queue
  // is empty — see useAttributionToasts for the one-at-a-time queue.
  readonly toast: { readonly id: string; readonly message: string } | null;
  readonly onDismissToast: () => void;
  // Queues a push/lock/unlock notification as a toast (design 1c); call
  // from the repository-notifications callback.
  readonly pushToast: (notification: RepositoryNotification) => void;
  // Opens Mission Control for the watched repository (design 1b/1c's
  // shared chip target — pill, card header, and footer icon).
  readonly onOpenMissionControl: () => void;
  // The branch's current tip revision number — the shared best-effort value
  // behind the working-set conflict row's "conflicts with rN" and this
  // hook's own "pushed rN" toast text (see WorkingSet's doc).
  readonly conflictRevisionNumber: number | undefined;
}

// Composes the pill/card's agent-attention chip and attribution toast
// (design 1b/1c) from P10's Mission Control snapshot and the notification
// pipeline: aggregate needsYou/active counts, the one-at-a-time toast
// queue formatted against live branch state, and the shared Mission
// Control launcher.
export function useAgentAttention(
  repositoryId: string | null,
  branchName: string,
  branchGraph: BranchGraph
): AgentAttentionState {
  const cards = useMissionControlSnapshot(repositoryId);
  const { needsYouCount, activeCount } = computeAgentAttention(cards);
  const toasts = useAttributionToasts();
  const conflictRevisionNumber = branchGraph.branch.revisions[0]?.revisionNumber;

  // Resolve the queued toast's userId to a display name (P5's
  // resolveUserName over IPC); null while unresolved or on a failed lookup,
  // in which case formatAttributionMessage's own raw-userId fallback shows
  // instead — never fabricated, per the spec.
  const rawUserId = toasts.current?.notification.userId ?? null;
  const resolvedName = useResolvedUserName(
    toasts.current?.notification.repositoryPath ?? null,
    rawUserId
  );

  const toastMessage =
    toasts.current !== null
      ? formatAttributionMessage(
          resolvedName
            ? { ...toasts.current.notification, userId: resolvedName }
            : toasts.current.notification,
          // Mirrors PlayerHeader/Pill's own branch-name fallback so the
          // toast never reads "pushed to " with a blank branch.
          branchName || 'main',
          conflictRevisionNumber
        )
      : null;

  const onOpenMissionControl = useCallback((): void => {
    window.electronAPI.missionControl.open(repositoryId ?? undefined);
  }, [repositoryId]);

  return {
    needsYouCount,
    activeCount,
    hasAttention: needsYouCount > 0,
    toast:
      toasts.current !== null && toastMessage !== null
        ? { id: toasts.current.id, message: toastMessage }
        : null,
    onDismissToast: toasts.dismiss,
    pushToast: toasts.push,
    onOpenMissionControl,
    conflictRevisionNumber,
  };
}
