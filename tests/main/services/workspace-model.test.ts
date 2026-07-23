import { EventEmitter } from 'node:events';
import {
  WorkspaceModelService,
  WorkspaceModelDeps,
  WorkspaceSignals,
  deriveAttention,
  WORKSPACE_MODEL_REFRESH_MS,
} from '../../../src/main/services/workspace-model';
import { WorkspaceModelSnapshotSchema } from '../../../src/shared/schemas';
import type {
  AgentIntention,
  BranchDivergence,
  BranchGraph,
  FileDiffResult,
  LoreBranch,
  LoreFileStatusGroup,
  Repository,
  Workspace,
  WorkspaceModelSnapshot,
} from '../../../src/shared/types';
import type { AgentSessionRecord } from '../../../src/main/services/agent-observer';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
const asLogger = mockLog as unknown as ConstructorParameters<typeof WorkspaceModelService>[0];

const REPO_ID = '11111111-1111-4111-8111-111111111111';

// --- fixtures ---------------------------------------------------------------

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    instanceId: 'inst-a',
    path: '/tmp/repo-wt/feature-a',
    branchName: 'feature-a',
    name: 'feature-a',
    revision: 'rev-a',
    stale: false,
    repositoryId: REPO_ID,
    origin: 'provisioned',
    provisionedAt: '2026-07-22T10:00:00.000Z',
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: 'sess-1',
    workspacePath: '/tmp/repo-wt/feature-a',
    status: 'active',
    lastEventAt: 1000,
    ...overrides,
  };
}

const CLEAN_STATUS: LoreFileStatusGroup = { untracked: [], unstaged: [], staged: [] };

function dirtyStatus(): LoreFileStatusGroup {
  return {
    untracked: [{ path: 'new.ts', isUntracked: true, isStaged: false, conflict: false }],
    unstaged: [],
    staged: [],
  };
}

function conflictStatus(): LoreFileStatusGroup {
  return {
    untracked: [],
    unstaged: [
      {
        path: 'c.ts',
        isUntracked: false,
        isStaged: false,
        conflict: true,
        conflictUnresolved: true,
      },
    ],
    staged: [],
  };
}

const IN_SYNC: BranchDivergence = { state: 'inSync', latest: 'x', latestRemote: 'x' };
const AHEAD: BranchDivergence = { state: 'ahead', latest: 'x', latestRemote: 'y' };
const BEHIND: BranchDivergence = { state: 'behindOrDiverged', latest: 'x', latestRemote: 'y' };

function emptyGraph(): BranchGraph {
  return {
    current: 'x',
    branch: { name: 'feature-a', revisions: [] },
    mergesFromParent: [],
    mergesToParent: [],
  };
}

// A graph whose branch lane carries two of its own commits plus a shared
// parent revision (the parent lineage must be excluded from session commits).
function graphWithOwnCommits(): BranchGraph {
  return {
    current: 'c2',
    branch: {
      name: 'feature-a',
      revisions: [
        { revision: 'c2', revisionNumber: 3, message: 'second', timestamp: 200 },
        { revision: 'c1', revisionNumber: 2, message: 'first', timestamp: 100 },
        { revision: 'p0', revisionNumber: 1, message: 'base', timestamp: 50 },
      ],
    },
    parent: {
      name: 'main',
      branchPoint: 'p0',
      revisions: [{ revision: 'p0', revisionNumber: 1, message: 'base', timestamp: 50 }],
    },
    mergesFromParent: [],
    mergesToParent: [],
  };
}

// --- fake dependencies ------------------------------------------------------

class FakeObserver extends EventEmitter {
  sessions: AgentSessionRecord[] = [];
  listSessions(): AgentSessionRecord[] {
    return this.sessions.map(record => ({ ...record }));
  }
}

class FakeLore extends EventEmitter {
  getFileStatus = jest.fn(
    async (_repositoryPath: string): Promise<LoreFileStatusGroup> => CLEAN_STATUS
  );
  getBranchDivergence = jest.fn(async (): Promise<BranchDivergence> => IN_SYNC);
  getBranchGraph = jest.fn(async (): Promise<BranchGraph> => emptyGraph());
  // Anchor-only signals (packet U3): resolving the card-view repo's current
  // branch + revision. Unused unless a test configures a repository record.
  listBranches = jest.fn(async (): Promise<LoreBranch[]> => []);
  getCurrentRevision = jest.fn(async (): Promise<string> => '');
}

class FakeWorkspaces extends EventEmitter {
  list: jest.Mock<Promise<Workspace[]>, [string]>;
  constructor(workspaces: Workspace[]) {
    super();
    this.list = jest.fn<Promise<Workspace[]>, [string]>(async () => workspaces);
  }
}

interface Harness {
  model: WorkspaceModelService;
  observer: FakeObserver;
  lore: FakeLore;
  workspaces: FakeWorkspaces;
  repository: { getById: jest.Mock<Promise<Repository | null>, [string]> };
  listWorkspaces: jest.Mock<Promise<Workspace[]>, [string]>;
  extract: jest.Mock<Promise<AgentIntention>, [string]>;
  workspaceDirtyStats: jest.Mock<Promise<FileDiffResult[]>, [string]>;
}

function makeHarness(workspaces: Workspace[], options: { refreshMs?: number } = {}): Harness {
  const observer = new FakeObserver();
  const lore = new FakeLore();
  const workspacesFake = new FakeWorkspaces(workspaces);
  const extract = jest.fn<Promise<AgentIntention>, [string]>(async () => ({
    tasks: [],
    commentary: [],
  }));
  const workspaceDirtyStats = jest.fn<Promise<FileDiffResult[]>, [string]>(async () => []);
  // Defaults to "no anchor record" — every existing snapshot test stays
  // exactly as it was (no anchor member) unless a test configures it.
  const repository = {
    getById: jest.fn<Promise<Repository | null>, [string]>(async () => null),
  };

  const deps: WorkspaceModelDeps = {
    workspaces: workspacesFake as unknown as WorkspaceModelDeps['workspaces'],
    observer: observer as unknown as WorkspaceModelDeps['observer'],
    transcript: { extract },
    lore: lore as unknown as WorkspaceModelDeps['lore'],
    diff: { workspaceDirtyStats },
    repository,
  };

  const model = new WorkspaceModelService(asLogger, deps, {
    ...(options.refreshMs !== undefined ? { refreshMs: options.refreshMs } : {}),
  });
  return {
    model,
    observer,
    lore,
    workspaces: workspacesFake,
    repository,
    listWorkspaces: workspacesFake.list,
    extract,
    workspaceDirtyStats,
  };
}

function onlyCard(snapshot: WorkspaceModelSnapshot): WorkspaceModelSnapshot['cards'][number] {
  const [card] = snapshot.cards;
  if (!card) {
    throw new Error('expected at least one card in the snapshot');
  }
  return card;
}

function baseSignals(overrides: Partial<WorkspaceSignals> = {}): WorkspaceSignals {
  return {
    markedActive: false,
    uncommitted: false,
    unpushed: false,
    diverged: false,
    conflict: false,
    reviewableCommits: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('deriveAttention — banding matrix', () => {
  it('active session → inProgress, no attention needed (quiet)', () => {
    const attention = deriveAttention(baseSignals({ sessionStatus: 'active' }));
    expect(attention.band).toBe('inProgress');
    expect(attention.needsYou).toBe(false);
    expect(attention.reasons).toEqual([]);
  });

  it('waitingOnUser → inProgress but needsYou (permissionPrompt)', () => {
    const attention = deriveAttention(baseSignals({ sessionStatus: 'waitingOnUser' }));
    expect(attention.band).toBe('inProgress');
    expect(attention.needsYou).toBe(true);
    expect(attention.reasons).toEqual(['permissionPrompt']);
  });

  it('stopped agent with uncommitted work → awaitingReview', () => {
    const attention = deriveAttention(baseSignals({ sessionStatus: 'stopped', uncommitted: true }));
    expect(attention.band).toBe('awaitingReview');
    expect(attention.reasons).toEqual(['reviewReady', 'uncommitted']);
  });

  it('ended agent with reviewable commits (clean tree) → awaitingReview', () => {
    const attention = deriveAttention(
      baseSignals({ sessionStatus: 'ended', reviewableCommits: true })
    );
    expect(attention.band).toBe('awaitingReview');
    expect(attention.reasons).toEqual(['reviewReady']);
  });

  it('stopped agent with nothing to review → idle', () => {
    const attention = deriveAttention(baseSignals({ sessionStatus: 'stopped' }));
    expect(attention.band).toBe('idle');
    expect(attention.needsYou).toBe(false);
    expect(attention.reasons).toEqual([]);
  });

  it('no session, clean tree (new workspace) → idle', () => {
    expect(deriveAttention(baseSignals()).band).toBe('idle');
  });

  it('degraded/hookless with uncommitted → awaitingReview WITHOUT reviewReady', () => {
    const attention = deriveAttention(baseSignals({ uncommitted: true }));
    expect(attention.band).toBe('awaitingReview');
    // Never claim agent knowledge that doesn't exist.
    expect(attention.reasons).not.toContain('reviewReady');
    expect(attention.reasons).toEqual(['uncommitted']);
  });

  it('degraded/hookless with unpushed → awaitingReview', () => {
    const attention = deriveAttention(baseSignals({ unpushed: true }));
    expect(attention.band).toBe('awaitingReview');
    expect(attention.reasons).toEqual(['unpushed']);
  });

  it('degraded/hookless ignores reviewable commits for banding', () => {
    // No session signal → reviewableCommits must NOT pull it to awaitingReview.
    expect(deriveAttention(baseSignals({ reviewableCommits: true })).band).toBe('idle');
  });

  it('markActive with no session and clean tree → awaitingReview', () => {
    const attention = deriveAttention(baseSignals({ markedActive: true }));
    expect(attention.band).toBe('awaitingReview');
    expect(attention.reasons).toEqual(['reviewReady']);
  });

  it('active session overrides a stale mark → inProgress', () => {
    const attention = deriveAttention(baseSignals({ sessionStatus: 'active', markedActive: true }));
    expect(attention.band).toBe('inProgress');
  });
});

describe('deriveAttention — reasons priority ordering', () => {
  it('orders every awaitingReview reason by contract priority', () => {
    const attention = deriveAttention(
      baseSignals({
        sessionStatus: 'stopped',
        conflict: true,
        diverged: true,
        unpushed: true,
        uncommitted: true,
      })
    );
    expect(attention.band).toBe('awaitingReview');
    expect(attention.reasons).toEqual([
      'conflict',
      'reviewReady',
      'diverged',
      'unpushed',
      'uncommitted',
    ]);
  });

  it('conflict outranks review in progress; permissionPrompt leads', () => {
    const attention = deriveAttention(
      baseSignals({ sessionStatus: 'waitingOnUser', conflict: true })
    );
    expect(attention.reasons).toEqual(['permissionPrompt', 'conflict']);
  });
});

describe('WorkspaceModelService.snapshot — card data', () => {
  it('bands an active agent workspace inProgress and attaches session + intention', async () => {
    const { model, observer, extract } = makeHarness([workspace()]);
    observer.sessions = [sessionRecord({ status: 'active', transcriptPath: '/t/sess.jsonl' })];
    extract.mockResolvedValueOnce({
      tasks: [],
      commentary: [],
      prompt: 'do the thing',
      summary: 'did the thing',
    });

    const snapshot = await model.snapshot(REPO_ID);

    expect(snapshot.repositoryId).toBe(REPO_ID);
    expect(snapshot.cards).toHaveLength(1);
    const card = onlyCard(snapshot);
    expect(card.attention.band).toBe('inProgress');
    expect(card.session?.status).toBe('active');
    expect(card.intention?.prompt).toBe('do the thing');
  });

  it('aggregates +/- line stats and counts changed files from the dirty-file stats', async () => {
    const { model, workspaceDirtyStats } = makeHarness([workspace()]);
    workspaceDirtyStats.mockResolvedValueOnce([
      {
        path: 'a.ts',
        action: 'modified',
        binary: false,
        truncated: false,
        lineStats: { added: 5, removed: 2 },
      },
      { path: 'b.png', action: 'added', binary: true, truncated: false },
      {
        path: 'c.ts',
        action: 'added',
        binary: false,
        truncated: false,
        lineStats: { added: 10, removed: 0 },
      },
    ]);

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.fileStats).toEqual({ added: 15, removed: 2 });
    expect(card.changedFileCount).toBe(3);
  });

  it('reports session commits as the branch own revisions, excluding parent lineage', async () => {
    const { model, lore, observer } = makeHarness([workspace()]);
    observer.sessions = [sessionRecord({ status: 'ended' })];
    lore.getBranchGraph.mockResolvedValueOnce(graphWithOwnCommits());

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.sessionCommits.map(rev => rev.revision)).toEqual(['c2', 'c1']);
    // Two own commits present → the ended agent lands in awaiting review.
    expect(card.attention.band).toBe('awaitingReview');
  });

  it('degrades a workspace whose Lore signals all throw to idle without failing', async () => {
    const { model, lore } = makeHarness([workspace()]);
    lore.getFileStatus.mockRejectedValueOnce(new Error('gone'));
    lore.getBranchDivergence.mockRejectedValueOnce(new Error('gone'));
    lore.getBranchGraph.mockRejectedValueOnce(new Error('gone'));

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('idle');
    expect(card.fileStats).toEqual({ added: 0, removed: 0 });
  });

  it('keeps stale instances listed (flagged) and idle', async () => {
    const stale = workspace({ instanceId: 'inst-stale', stale: true });
    const { model } = makeHarness([stale]);
    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.workspace.stale).toBe(true);
    expect(card.attention.band).toBe('idle');
  });

  it('maps ahead divergence to an unpushed reason (hookless awaiting review)', async () => {
    const { model, lore } = makeHarness([workspace()]);
    lore.getBranchDivergence.mockResolvedValueOnce(AHEAD);

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('awaitingReview');
    expect(card.attention.reasons).toContain('unpushed');
  });

  it('maps behindOrDiverged divergence to a diverged reason on a finished agent', async () => {
    const { model, lore, observer } = makeHarness([workspace()]);
    observer.sessions = [sessionRecord({ status: 'stopped' })];
    // A dirty tree pulls the finished agent into awaiting review, where the
    // behind/diverged divergence surfaces as its own reason.
    lore.getFileStatus.mockResolvedValueOnce(dirtyStatus());
    lore.getBranchDivergence.mockResolvedValueOnce(BEHIND);

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('awaitingReview');
    expect(card.attention.reasons).toContain('diverged');
  });

  it('marks conflict as a needs-you reason from status flags', async () => {
    const { model, lore, observer } = makeHarness([workspace()]);
    observer.sessions = [sessionRecord({ status: 'stopped' })];
    lore.getFileStatus.mockResolvedValueOnce(conflictStatus());

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.reasons).toContain('conflict');
    expect(card.attention.needsYou).toBe(true);
  });

  it('orders cards: awaiting review, then in progress, then idle', async () => {
    const awaiting = workspace({
      instanceId: 'w-review',
      path: '/tmp/repo-wt/review',
      branchName: 'review',
    });
    const working = workspace({
      instanceId: 'w-work',
      path: '/tmp/repo-wt/work',
      branchName: 'work',
    });
    const idle = workspace({ instanceId: 'w-idle', path: '/tmp/repo-wt/idle', branchName: 'idle' });
    const { model, observer, lore } = makeHarness([idle, working, awaiting]);
    observer.sessions = [
      sessionRecord({ sessionId: 's-work', workspacePath: '/tmp/repo-wt/work', status: 'active' }),
      sessionRecord({
        sessionId: 's-rev',
        workspacePath: '/tmp/repo-wt/review',
        status: 'stopped',
      }),
    ];
    lore.getFileStatus.mockImplementation(async (repositoryPath: string) =>
      repositoryPath === '/tmp/repo-wt/review' ? dirtyStatus() : CLEAN_STATUS
    );

    const cards = (await model.snapshot(REPO_ID)).cards;
    expect(cards.map(card => card.workspace.instanceId)).toEqual(['w-review', 'w-work', 'w-idle']);
  });

  it('degrades a failing branch diff and transcript to empty card data', async () => {
    const { model, observer, workspaceDirtyStats, extract } = makeHarness([workspace()]);
    observer.sessions = [sessionRecord({ status: 'stopped', transcriptPath: '/t/s.jsonl' })];
    workspaceDirtyStats.mockRejectedValueOnce(new Error('diff failed'));
    extract.mockRejectedValueOnce(new Error('transcript unreadable'));

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.fileStats).toEqual({ added: 0, removed: 0 });
    expect(card.changedFileCount).toBe(0);
    expect(card.intention).toBeUndefined();
  });

  it('uses provisionedAt for lastEventAt when there is no session', async () => {
    const withTs = workspace({ provisionedAt: '2026-07-22T10:00:00.000Z' });
    const withoutTs = workspace({
      instanceId: 'inst-b',
      path: '/tmp/repo-wt/feature-b',
      branchName: 'feature-b',
    });
    delete (withoutTs as { provisionedAt?: string }).provisionedAt;
    const { model } = makeHarness([withTs, withoutTs]);

    const cards = (await model.snapshot(REPO_ID)).cards;
    const byId = new Map(cards.map(card => [card.workspace.instanceId, card]));
    expect(byId.get('inst-a')?.lastEventAt).toBe(Date.parse('2026-07-22T10:00:00.000Z'));
    expect(byId.get('inst-b')?.lastEventAt).toBe(0);
  });

  it('orders within a band: needs-you first, then most-recent activity', async () => {
    const blocked = workspace({
      instanceId: 'w-blocked',
      path: '/tmp/repo-wt/blocked',
      branchName: 'blocked',
    });
    const working = workspace({
      instanceId: 'w-working',
      path: '/tmp/repo-wt/working',
      branchName: 'working',
    });
    const { model, observer } = makeHarness([working, blocked]);
    observer.sessions = [
      sessionRecord({
        sessionId: 's-block',
        workspacePath: '/tmp/repo-wt/blocked',
        status: 'waitingOnUser',
        lastEventAt: 10,
      }),
      sessionRecord({
        sessionId: 's-work',
        workspacePath: '/tmp/repo-wt/working',
        status: 'active',
        lastEventAt: 99,
      }),
    ];

    const cards = (await model.snapshot(REPO_ID)).cards;
    // Both inProgress; the blocked (needs-you) one leads despite older activity.
    expect(cards.map(card => card.workspace.instanceId)).toEqual(['w-blocked', 'w-working']);
  });

  it('orders two quiet idle workspaces by most-recent activity', async () => {
    const older = workspace({
      instanceId: 'w-old',
      path: '/tmp/repo-wt/old',
      branchName: 'old',
      provisionedAt: '2026-07-22T09:00:00.000Z',
    });
    const newer = workspace({
      instanceId: 'w-new',
      path: '/tmp/repo-wt/new',
      branchName: 'new',
      provisionedAt: '2026-07-22T11:00:00.000Z',
    });
    const { model } = makeHarness([older, newer]);

    const cards = (await model.snapshot(REPO_ID)).cards;
    expect(cards.map(card => card.workspace.instanceId)).toEqual(['w-new', 'w-old']);
  });

  it('validates every emitted snapshot against the P2 schema', async () => {
    const { model } = makeHarness([workspace()]);
    const snapshot = await model.snapshot(REPO_ID);
    expect(() => WorkspaceModelSnapshotSchema.parse(snapshot)).not.toThrow();
  });
});

describe('WorkspaceModelService.markActive', () => {
  it('moves a resolved idle workspace to awaiting review', async () => {
    const { model } = makeHarness([workspace()]);
    await model.snapshot(REPO_ID); // populate the resolution cache

    const returned = await model.markActive('inst-a');
    expect(returned.instanceId).toBe('inst-a');

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('awaitingReview');
    expect(card.attention.reasons).toContain('reviewReady');
  });

  it('throws for an unknown workspace id', async () => {
    const { model } = makeHarness([workspace()]);
    await expect(model.markActive('nope')).rejects.toThrow('Unknown workspace');
  });

  it('clears the mark when a new agent session starts', async () => {
    const { model, observer } = makeHarness([workspace()]);
    // Mark while a stopped session is present (baseline = sess-old).
    observer.sessions = [sessionRecord({ sessionId: 'sess-old', status: 'stopped' })];
    await model.snapshot(REPO_ID);
    await model.markActive('inst-a');

    let card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('awaitingReview');

    // A brand-new session starts → the mark is cleared, band follows the live
    // session again.
    observer.sessions = [
      sessionRecord({ sessionId: 'sess-new', status: 'active', lastEventAt: 5000 }),
    ];
    card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('inProgress');
  });
});

describe('WorkspaceModelService.refreshNow — manual refresh control', () => {
  it('rebuilds and emits a snapshot for the currently watched repository', async () => {
    const { model } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush();
    expect(emitted).toHaveLength(1); // initial, from watch()

    await model.refreshNow(REPO_ID);
    expect(emitted).toHaveLength(2); // manual refresh reuses the same path

    model.unwatch();
  });

  it('is a no-op for a repository that is not the one currently watched', async () => {
    const { model } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush();
    expect(emitted).toHaveLength(1);

    await model.refreshNow('22222222-2222-4222-8222-222222222222');
    expect(emitted).toHaveLength(1); // unchanged: not the watched repository

    model.unwatch();
  });

  it('is a no-op when no repository is being watched', async () => {
    const { model } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    await model.refreshNow(REPO_ID);
    expect(emitted).toHaveLength(0);
  });
});

describe('WorkspaceModelService.watch — event-driven emission', () => {
  it('emits a snapshot on watch, on an agent push, and on a repository notification', async () => {
    const { model, observer, lore } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush();
    expect(emitted).toHaveLength(1); // initial

    observer.emit('push');
    await flush();
    expect(emitted).toHaveLength(2);

    lore.emit('notification');
    await flush();
    expect(emitted).toHaveLength(3);

    model.unwatch();
  });

  it('is idempotent when re-watching the same repository', async () => {
    const { model } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush();
    model.watch(REPO_ID); // same repo → early return, no re-subscribe/re-emit
    await flush();
    expect(emitted).toHaveLength(1);

    model.unwatch();
  });

  it('logs and skips (never throws) when a watched refresh build fails', async () => {
    const { model, listWorkspaces } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));
    listWorkspaces.mockRejectedValue(new Error('list boom'));

    model.watch(REPO_ID);
    await flush();
    expect(emitted).toHaveLength(0);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Failed to build workspace snapshot',
      expect.objectContaining({ operation: 'workspace-model:refresh' })
    );

    model.unwatch();
  });

  it('stops emitting after unwatch (listeners + timer released)', async () => {
    const { model, observer } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush();
    const countAtUnwatch = emitted.length;

    model.unwatch();
    observer.emit('push');
    await flush();
    expect(emitted).toHaveLength(countAtUnwatch);
  });
});

describe('WorkspaceModelService.watch — workspace lifecycle events', () => {
  it('emits a fresh snapshot when the workspace service reports a lifecycle change (provision/teardown)', async () => {
    // Given: the model is watching a repository
    const { model, workspaces } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush();
    expect(emitted).toHaveLength(1); // initial

    // When: the workspace service reports a lifecycle change (e.g. a provision
    // or teardown completed) instead of waiting for the 30s cadence
    workspaces.emit('lifecycle', { repositoryId: REPO_ID, path: '/tmp/repo-wt/feature-b' });
    await flush();

    // Then: a fresh snapshot is emitted immediately
    expect(emitted).toHaveLength(2);

    model.unwatch();
  });

  it('stops reacting to lifecycle events after unwatch (listener released)', async () => {
    // Given: a watched model is then unwatched
    const { model, workspaces } = makeHarness([workspace()]);
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush();
    const countAtUnwatch = emitted.length;
    model.unwatch();

    // When: a lifecycle event still arrives after unwatch
    workspaces.emit('lifecycle', { repositoryId: REPO_ID, path: '/tmp/repo-wt/feature-b' });
    await flush();

    // Then: nothing is emitted — the listener was released
    expect(emitted).toHaveLength(countAtUnwatch);
  });
});

describe('WorkspaceModelService.watch — bounded refresh cadence', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('refreshes at the cadence, not faster, and stops on unwatch', async () => {
    const { model } = makeHarness([workspace()], { refreshMs: 30_000 });
    const emitted: WorkspaceModelSnapshot[] = [];
    model.on('snapshot', snapshot => emitted.push(snapshot));

    model.watch(REPO_ID);
    await flush(); // initial snapshot
    expect(emitted).toHaveLength(1);

    jest.advanceTimersByTime(29_999);
    await flush();
    expect(emitted).toHaveLength(1); // not yet

    jest.advanceTimersByTime(1);
    await flush();
    expect(emitted).toHaveLength(2); // one refresh tick

    model.unwatch();
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(emitted).toHaveLength(2); // timer cleared
  });

  it('exposes a low-frequency default cadence (does not multiply the 3s polls)', () => {
    expect(WORKSPACE_MODEL_REFRESH_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('WorkspaceModelService.snapshot — anchor workspace (packet U3)', () => {
  function anchorRepo(overrides: Partial<Repository> = {}): Repository {
    return {
      id: REPO_ID,
      name: 'anchor-repo',
      url: 'lore://host/anchor-repo',
      localPath: '/repo/anchor',
      accentHue: 10,
      origin: 'attached',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('includes the anchor as a member marked isActive, alongside its provisioned worktrees', async () => {
    const { model, repository, lore } = makeHarness([workspace()]);
    repository.getById.mockResolvedValue(anchorRepo());
    lore.listBranches.mockResolvedValue([
      { name: 'feature-x', isDefault: false, isCurrent: false },
      { name: 'main', isDefault: true, isCurrent: true },
    ]);
    lore.getCurrentRevision.mockResolvedValue('rev-anchor');

    const snapshot = await model.snapshot(REPO_ID);
    expect(snapshot.cards).toHaveLength(2);

    const anchorCard = snapshot.cards.find(card => card.workspace.instanceId === REPO_ID);
    expect(anchorCard?.isActive).toBe(true);
    expect(anchorCard?.workspace.branchName).toBe('main');
    expect(anchorCard?.workspace.path).toBe('/repo/anchor');
    expect(anchorCard?.workspace.revision).toBe('rev-anchor');
    expect(anchorCard?.workspace.stale).toBe(false);

    const provisionedCard = snapshot.cards.find(card => card.workspace.instanceId === 'inst-a');
    expect(provisionedCard?.isActive).toBe(false);
  });

  it('omits the anchor when the repository record cannot be resolved (backward compatible)', async () => {
    const { model, repository } = makeHarness([workspace()]);
    repository.getById.mockResolvedValue(null);

    const snapshot = await model.snapshot(REPO_ID);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]?.isActive).toBe(false);
  });

  it('omits the anchor when its current branch cannot be resolved, without failing the snapshot', async () => {
    const { model, repository, lore } = makeHarness([workspace()]);
    repository.getById.mockResolvedValue(anchorRepo());
    lore.listBranches.mockRejectedValue(new Error('boom'));

    const snapshot = await model.snapshot(REPO_ID);
    expect(snapshot.cards).toHaveLength(1);
  });

  it('omits the anchor when no branch reports isCurrent', async () => {
    const { model, repository, lore } = makeHarness([workspace()]);
    repository.getById.mockResolvedValue(anchorRepo());
    lore.listBranches.mockResolvedValue([{ name: 'main', isDefault: true, isCurrent: false }]);

    const snapshot = await model.snapshot(REPO_ID);
    expect(snapshot.cards).toHaveLength(1);
  });

  it('bands a dirty attached-origin anchor (no agent, no provisionedAt) from Lore signals alone', async () => {
    const { model, repository, lore } = makeHarness([]);
    repository.getById.mockResolvedValue(anchorRepo());
    lore.listBranches.mockResolvedValue([{ name: 'main', isDefault: true, isCurrent: true }]);
    lore.getFileStatus.mockResolvedValue(dirtyStatus());

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('awaitingReview');
    expect(card.attention.reasons).toEqual(['uncommitted']);
    // Never claim agent knowledge that doesn't exist for a hookless anchor.
    expect(card.session).toBeUndefined();
    expect(card.intention).toBeUndefined();
  });

  it('bands a clean attached-origin anchor idle', async () => {
    const { model, repository, lore } = makeHarness([]);
    repository.getById.mockResolvedValue(anchorRepo());
    lore.listBranches.mockResolvedValue([{ name: 'main', isDefault: true, isCurrent: true }]);

    const card = onlyCard(await model.snapshot(REPO_ID));
    expect(card.attention.band).toBe('idle');
  });

  it('validates an anchor-including snapshot against the P2 schema', async () => {
    const { model, repository, lore } = makeHarness([workspace()]);
    repository.getById.mockResolvedValue(anchorRepo());
    lore.listBranches.mockResolvedValue([{ name: 'main', isDefault: true, isCurrent: true }]);

    const snapshot = await model.snapshot(REPO_ID);
    expect(() => WorkspaceModelSnapshotSchema.parse(snapshot)).not.toThrow();
  });
});

// Drain the microtask queue deeply so an async refresh() (list → per-card
// Promise.all) settles before assertions, under both real and fake timers.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}
