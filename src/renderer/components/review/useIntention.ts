import type { AgentIntention } from '../../../shared/types';
import { useMissionControlSnapshot } from '../../hooks/useMissionControlSnapshot';

// The review window's intention source (P12): rather than a new IPC channel,
// this reuses P9/P10's workspace model snapshot (already carrying
// WorkspaceCard.intention, the richest existing source of AgentIntention) —
// the same `missionControl.watch`/`onSnapshot` bridge Mission Control itself
// drives. Selects the one card matching this review window's workspace path;
// null when the workspace has no card yet or the card carries no intention
// (transcript enrichment absent/disabled), which the panel renders as its
// diff-only placeholder.
export function useIntention(repositoryId: string, workspacePath: string): AgentIntention | null {
  const cards = useMissionControlSnapshot(repositoryId);
  const card = cards.find(candidate => candidate.workspace.path === workspacePath);
  return card?.intention ?? null;
}
