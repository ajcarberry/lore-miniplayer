import type { WorkspaceCard } from '../../shared/types';

// The aggregate counts behind the pill/card attention chip (design 1b/1c):
// how many of the repo's workspaces need the human right now, and how many
// are quietly active otherwise. The chip is tri-state from these two counts
// alone — needsYou wins when both are nonzero (see AttentionChip).
export interface AgentAttentionCounts {
  readonly needsYouCount: number;
  readonly activeCount: number;
}

// `needsYou` is Mission Control's own per-card verdict (P9's model), so the
// pill/card chip stays consistent with the Mission Control bands by
// construction. "Active" mirrors the in-progress band — an agent is
// currently working and hasn't raised its hand.
export function computeAgentAttention(cards: readonly WorkspaceCard[]): AgentAttentionCounts {
  return {
    needsYouCount: cards.filter(card => card.attention.needsYou).length,
    activeCount: cards.filter(card => card.attention.band === 'inProgress').length,
  };
}
