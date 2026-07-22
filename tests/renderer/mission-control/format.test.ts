import {
  deriveWorkspaceFlags,
  formatCommitAge,
  formatCost,
  formatElapsed,
  previewWorkspaceDir,
  resolveCostUsd,
} from '../../../src/renderer/components/mission-control/format';
import { makeCard } from './fixtures';

describe('deriveWorkspaceFlags', () => {
  it('flags uncommitted work as dirty and force-required', () => {
    // Given: an awaiting-review card whose only reason is uncommitted
    const card = makeCard('awaitingReview', {
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['uncommitted'] },
    });

    // Then: dirty + requiresForce
    expect(deriveWorkspaceFlags(card)).toEqual({
      dirty: true,
      unpushed: false,
      requiresForce: true,
      isRepoCheckout: false,
    });
  });

  it('treats unpushed and diverged as unpushed and force-required', () => {
    const card = makeCard('awaitingReview', {
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['diverged'] },
    });
    expect(deriveWorkspaceFlags(card)).toEqual({
      dirty: false,
      unpushed: true,
      requiresForce: true,
      isRepoCheckout: false,
    });
  });

  it('is clean with no dirty/unpushed reasons', () => {
    const card = makeCard('awaitingReview', {
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
    });
    expect(deriveWorkspaceFlags(card)).toEqual({
      dirty: false,
      unpushed: false,
      requiresForce: false,
      isRepoCheckout: false,
    });
  });

  it('flags a clean attached-origin workspace as a repo checkout, independent of requiresForce', () => {
    // Given: an origin-'attached' workspace with no dirty/unpushed reasons at all
    const card = makeCard('idle', {
      attention: { band: 'idle', needsYou: false, reasons: [] },
      workspace: { ...makeCard('idle').workspace, origin: 'attached' },
    });

    // Then: isRepoCheckout is true purely from origin; requiresForce (dirty/
    // unpushed only) stays false — the caller ORs both to gate the checkbox
    expect(deriveWorkspaceFlags(card)).toEqual({
      dirty: false,
      unpushed: false,
      requiresForce: false,
      isRepoCheckout: true,
    });
  });
});

describe('resolveCostUsd / formatCost', () => {
  it('prefers the live session cost', () => {
    const card = makeCard('inProgress', {
      session: {
        sessionId: 's1',
        workspacePath: '/w',
        status: 'active',
        lastEventAt: 1,
        costUsd: 1.62,
      },
      intention: { tasks: [], commentary: [], costUsd: 9.99 },
    });
    expect(resolveCostUsd(card)).toBe(1.62);
    expect(formatCost(resolveCostUsd(card))).toBe('$1.62');
  });

  it('falls back to the transcript cost, then null when neither is present', () => {
    const withIntention = makeCard('awaitingReview', {
      intention: { tasks: [], commentary: [], costUsd: 0.84 },
    });
    expect(formatCost(resolveCostUsd(withIntention))).toBe('$0.84');

    const degraded = makeCard('idle');
    expect(resolveCostUsd(degraded)).toBeNull();
    expect(formatCost(null)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('renders minutes and seconds, dropping minutes under a minute', () => {
    expect(formatElapsed(7 * 60_000 + 12_000)).toBe('7m 12s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(-100)).toBe('0s');
  });
});

describe('formatCommitAge', () => {
  const now = Date.UTC(2026, 6, 22, 12, 0, 0);

  it('formats seconds- and millisecond-epoch timestamps as coarse ages', () => {
    expect(formatCommitAge(now - 6 * 60_000, now)).toBe('6m');
    expect(formatCommitAge((now - 3 * 3_600_000) / 1000, now)).toBe('3h');
    expect(formatCommitAge(now - 2 * 86_400_000, now)).toBe('2d');
    expect(formatCommitAge(now - 30_000, now)).toBe('<1m');
  });

  it('returns null when the timestamp was dropped', () => {
    expect(formatCommitAge(undefined, now)).toBeNull();
  });
});

describe('previewWorkspaceDir', () => {
  it('mirrors the P3 worktree layout (<parent>/<repo>-wt/<branch>)', () => {
    expect(previewWorkspaceDir('/Users/rowan/work/emberfall', 'agent/act2')).toBe(
      '/Users/rowan/work/emberfall-wt/agent/act2'
    );
  });

  it('tolerates a trailing slash and previews a placeholder when the branch is blank', () => {
    expect(previewWorkspaceDir('/Users/rowan/work/emberfall/', '')).toBe(
      '/Users/rowan/work/emberfall-wt/<branch>'
    );
  });

  it('handles Windows-style paths', () => {
    expect(previewWorkspaceDir('C:\\work\\emberfall', 'fix')).toBe('C:\\work\\emberfall-wt\\fix');
  });
});
