import { computeAgentAttention } from '../../src/renderer/utils/agentAttention';
import { makeCard } from './mission-control/fixtures';

describe('computeAgentAttention', () => {
  it('returns zero counts for an empty snapshot', () => {
    // When: no workspace cards at all
    const counts = computeAgentAttention([]);

    // Then: both counts are zero
    expect(counts).toEqual({ needsYouCount: 0, activeCount: 0 });
  });

  it('counts cards whose attention needsYou is true, regardless of band', () => {
    // Given: two cards needing you, one idle card that does not
    const cards = [
      makeCard('awaitingReview', {
        attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
      }),
      makeCard('inProgress', {
        attention: { band: 'inProgress', needsYou: true, reasons: ['permissionPrompt'] },
      }),
      makeCard('idle', { attention: { band: 'idle', needsYou: false, reasons: [] } }),
    ];

    // When: computing the aggregate
    const counts = computeAgentAttention(cards);

    // Then: only the two needing attention are counted
    expect(counts.needsYouCount).toBe(2);
  });

  it('counts in-progress cards as active, whether or not they need you', () => {
    // Given: one in-progress card needing attention, one quietly working,
    // one idle
    const cards = [
      makeCard('inProgress', {
        attention: { band: 'inProgress', needsYou: true, reasons: ['permissionPrompt'] },
      }),
      makeCard('inProgress', { attention: { band: 'inProgress', needsYou: false, reasons: [] } }),
      makeCard('idle', { attention: { band: 'idle', needsYou: false, reasons: [] } }),
    ];

    // When: computing the aggregate
    const counts = computeAgentAttention(cards);

    // Then: both in-progress cards count as active
    expect(counts.activeCount).toBe(2);
    expect(counts.needsYouCount).toBe(1);
  });

  it('reports no active count for idle-only or awaiting-review-only snapshots', () => {
    // Given: cards outside the in-progress band
    const cards = [
      makeCard('idle'),
      makeCard('awaitingReview', {
        attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
      }),
    ];

    // When: computing the aggregate
    const counts = computeAgentAttention(cards);

    // Then: active stays zero — only in-progress counts as "working"
    expect(counts.activeCount).toBe(0);
    expect(counts.needsYouCount).toBe(1);
  });
});
