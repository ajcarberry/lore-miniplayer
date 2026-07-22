import {
  deriveWorkspaceFlags,
  formatCommitAge,
  formatCost,
  formatElapsed,
  groupRepositoriesByRepo,
  previewWorkspaceDir,
  resolveCostUsd,
  selectedRepositoryGroup,
} from '../../../src/renderer/components/mission-control/format';
import { makeCard, makeRepository } from './fixtures';

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

describe('groupRepositoriesByRepo', () => {
  it('collapses same-repo entries (an attached sibling like "adfa") into one group keyed by url', () => {
    // Given: two registry entries sharing a url — the anchor and an attached
    // sibling workspace of the same Lore repo (no loreRepositoryId resolved)
    const anchor = makeRepository({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'demo-project',
      url: 'lore://host/team/demo-project',
      origin: 'attached',
    });
    const sibling = makeRepository({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'adfa',
      url: 'lore://host/team/demo-project',
      origin: 'attached',
    });

    const groups = groupRepositoriesByRepo([anchor, sibling]);

    // Then: one group, named from the url, representative is a member id
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'lore://host/team/demo-project',
      name: 'demo-project',
      memberIds: [anchor.id, sibling.id],
    });
    expect([anchor.id, sibling.id]).toContain(groups[0]!.representativeId);
  });

  it('groups by loreRepositoryId over url when present, and prefers it as the key', () => {
    const a = makeRepository({
      id: '11111111-1111-4111-8111-111111111111',
      url: 'local://existing',
      loreRepositoryId: 'repo-abc',
      origin: 'attached',
    });
    const b = makeRepository({
      id: '22222222-2222-4222-8222-222222222222',
      url: 'lore://host/team/demo-project',
      loreRepositoryId: 'repo-abc',
      origin: 'attached',
    });

    const groups = groupRepositoriesByRepo([a, b]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('repo-abc');
    expect(groups[0]!.memberIds).toEqual([a.id, b.id]);
  });

  it('union-merges an entry with only a url and a sibling with the same url + id (false-split fix)', () => {
    // Given: the field-reported mixed-key case — the original attach entry has
    // only a url, the healed sibling has the same url AND a resolved id. A
    // per-entry `id ?? url` key would produce two "demo-project" groups; the
    // shared union-merge must collapse them to one.
    const original = makeRepository({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'demo-project',
      url: 'lore://host/team/demo-project',
      origin: 'attached',
    });
    const healed = makeRepository({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'adfa',
      url: 'lore://host/team/demo-project',
      loreRepositoryId: 'repo-1',
      origin: 'attached',
    });

    const groups = groupRepositoriesByRepo([original, healed]);

    // Then: one group keyed by the resolved id, both entries as members
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('repo-1');
    expect(groups[0]!.memberIds).toEqual([original.id, healed.id]);
  });

  it('union-merges two entries linked by a shared id even when their urls differ', () => {
    // Given: A has url1 + id; B has a different url2 but the same id
    const a = makeRepository({
      id: '11111111-1111-4111-8111-111111111111',
      url: 'lore://host/team/demo-project',
      loreRepositoryId: 'repo-1',
      origin: 'attached',
    });
    const b = makeRepository({
      id: '22222222-2222-4222-8222-222222222222',
      url: 'local://existing',
      loreRepositoryId: 'repo-1',
      origin: 'attached',
    });

    const groups = groupRepositoriesByRepo([a, b]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('repo-1');
    expect(groups[0]!.memberIds).toEqual([a.id, b.id]);
  });

  it('keeps distinct repos as separate groups', () => {
    const emberfall = makeRepository({ url: 'lore://host/emberfall' });
    const brackwater = makeRepository({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'brackwater',
      url: 'lore://host/brackwater',
    });

    const groups = groupRepositoriesByRepo([emberfall, brackwater]);

    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.name)).toEqual(['emberfall', 'brackwater']);
  });

  it('prefers an attached/cloned member as the representative over a provisioned one', () => {
    const provisioned = makeRepository({
      id: '11111111-1111-4111-8111-111111111111',
      url: 'lore://host/emberfall',
      origin: 'provisioned',
      name: 'agent/act2-balance',
      branchName: 'agent/act2-balance',
    });
    const anchor = makeRepository({
      id: '33333333-3333-4333-8333-333333333333',
      url: 'lore://host/emberfall',
      origin: 'attached',
    });

    const groups = groupRepositoriesByRepo([provisioned, anchor]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.representativeId).toBe(anchor.id);
  });
});

describe('selectedRepositoryGroup', () => {
  it('finds the group containing the selected repository id', () => {
    const groups = groupRepositoriesByRepo([
      makeRepository({ id: '11111111-1111-4111-8111-111111111111', url: 'lore://host/a' }),
      makeRepository({ id: '22222222-2222-4222-8222-222222222222', url: 'lore://host/b' }),
    ]);
    expect(selectedRepositoryGroup(groups, '22222222-2222-4222-8222-222222222222')).toMatchObject({
      key: 'lore://host/b',
    });
  });

  it('returns null when nothing is selected or no group matches', () => {
    const groups = groupRepositoriesByRepo([makeRepository()]);
    expect(selectedRepositoryGroup(groups, null)).toBeNull();
    expect(selectedRepositoryGroup(groups, 'not-a-member')).toBeNull();
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
