import { EventEmitter } from 'node:events';
import type { MainLogger } from '../ipc/logger';
import type {
  AgentIntention,
  AgentSessionStatus,
  BranchDivergence,
  FileDiffResult,
  LineStats,
  LoreFileStatusGroup,
  Repository,
  RevisionSummary,
  Workspace,
  WorkspaceAttention,
  WorkspaceAttentionReason,
  WorkspaceCard,
  WorkspaceModelSnapshot,
} from '../../shared/types';
import { WorkspaceModelSnapshotSchema } from '../../shared/schemas';
import { toSessionState } from './agent-observer';
import type { AgentSessionRecord } from './agent-observer';
import type { WorkspaceRevisionStatus } from './lore-repository';
import { hasConflict, isDirty } from './lore-status';
import { samePath } from './path-utils';
import { composeMembers, logDegrade, resolveAnchorWorkspace } from './workspace-anchor';

// Low-frequency refresh cadence (ms) for the watched repository. Snapshots are
// primarily event-driven (agent pushes, repository notifications); this timer
// only catches Lore-side changes that arrive through neither — new commits, a
// divergence shift — without multiplying the existing 3s divergence polls.
export const WORKSPACE_MODEL_REFRESH_MS = 30_000;

// Newest-N session commits surfaced on a card (the branch's own revisions).
const SESSION_COMMITS_CAP = 10;

// `needsYou` reason priority (packet contract): permissionPrompt > conflict >
// reviewReady > diverged > unpushed > uncommitted. idlePrompt is folded into
// permissionPrompt-level urgency — the observer collapses both prompt kinds to
// `waitingOnUser`, so the model cannot distinguish them and reports the higher
// signal (permissionPrompt).
const REASON_PRIORITY: readonly WorkspaceAttentionReason[] = [
  'permissionPrompt',
  'conflict',
  'reviewReady',
  'diverged',
  'unpushed',
  'uncommitted',
];

// Band sort rank for snapshot ordering (design 2a: awaiting review leads).
const BAND_RANK = { awaitingReview: 0, inProgress: 1, idle: 2 } as const;

// The Lore signals distilled from a workspace checkout that drive banding.
export interface WorkspaceSignals {
  readonly sessionStatus?: AgentSessionStatus;
  readonly markedActive: boolean;
  readonly uncommitted: boolean;
  readonly unpushed: boolean;
  readonly diverged: boolean;
  readonly conflict: boolean;
  readonly reviewableCommits: boolean;
}

// Pure banding + attention derivation (packet "Contracts (honors)"). Kept a
// free function so the full transition matrix is testable without the service.
export function deriveAttention(signals: WorkspaceSignals): WorkspaceAttention {
  const band = deriveBand(signals);
  const reasons = deriveReasons(band, signals);
  return { band, needsYou: reasons.length > 0, reasons };
}

function deriveBand(signals: WorkspaceSignals): WorkspaceAttention['band'] {
  const { sessionStatus, markedActive, uncommitted, unpushed, reviewableCommits } = signals;

  // Live agent work wins outright.
  if (sessionStatus === 'active' || sessionStatus === 'waitingOnUser') {
    return 'inProgress';
  }
  // Manual "mark active" is a persisted transition to awaiting review.
  if (markedActive) {
    return 'awaitingReview';
  }
  // A finished agent with anything to look at.
  if (sessionStatus === 'stopped' || sessionStatus === 'ended') {
    return uncommitted || unpushed || reviewableCommits ? 'awaitingReview' : 'idle';
  }
  // Degraded/hookless: band purely from Lore signals, never pretending agent
  // knowledge that doesn't exist (reviewable-commits is agent-derived, so it
  // is deliberately excluded here).
  return uncommitted || unpushed ? 'awaitingReview' : 'idle';
}

function deriveReasons(
  band: WorkspaceAttention['band'],
  signals: WorkspaceSignals
): WorkspaceAttentionReason[] {
  const found = new Set<WorkspaceAttentionReason>();

  if (band === 'inProgress') {
    // A quiet, working agent needs nothing; only a prompt or a conflict does.
    if (signals.sessionStatus === 'waitingOnUser') {
      found.add('permissionPrompt');
    }
    if (signals.conflict) {
      found.add('conflict');
    }
  } else if (band === 'awaitingReview') {
    if (signals.conflict) {
      found.add('conflict');
    }
    // reviewReady only when the agent actually finished or was marked — never
    // claimed in degraded/hookless mode.
    const agentDone =
      signals.markedActive ||
      signals.sessionStatus === 'stopped' ||
      signals.sessionStatus === 'ended';
    if (agentDone) {
      found.add('reviewReady');
    }
    if (signals.diverged) {
      found.add('diverged');
    }
    if (signals.unpushed) {
      found.add('unpushed');
    }
    if (signals.uncommitted) {
      found.add('uncommitted');
    }
  }
  // idle: nothing awaiting — no reasons.

  return REASON_PRIORITY.filter(reason => found.has(reason));
}

// The service dependencies, as narrow structural interfaces so tests inject
// lightweight fakes and the model never reaches the SDK directly.
export interface WorkspaceModelDeps {
  readonly workspaces: {
    list(repositoryId: string): Promise<Workspace[]>;
    // A bare signal (provision/adoption/teardown/forget completed) — the
    // model only ever refreshes in response, so it carries no payload.
    on(event: 'lifecycle', listener: () => void): unknown;
    off(event: 'lifecycle', listener: () => void): unknown;
  };
  readonly observer: {
    listSessions(): AgentSessionRecord[];
    on(event: 'push', listener: () => void): unknown;
    off(event: 'push', listener: () => void): unknown;
  };
  readonly transcript: {
    extract(transcriptPath: string): Promise<AgentIntention>;
  };
  readonly lore: {
    getFileStatus(repositoryPath: string): Promise<LoreFileStatusGroup>;
    // One repositoryStatus({ revisionOnly: true }) call per card: current
    // branch + revision (the anchor's identity, packet U3) and the SDK's own
    // ahead/behind divergence flags (C25/C27).
    getWorkspaceRevisionStatus(
      repositoryPath: string
    ): Promise<WorkspaceRevisionStatus | undefined>;
    // The checkout branch's own newest revisions via revisionHistory's
    // onlyBranch stop — no branch-graph assembly (C23).
    getSessionCommits(repositoryPath: string, limit: number): Promise<RevisionSummary[]>;
    on(event: 'notification', listener: () => void): unknown;
    off(event: 'notification', listener: () => void): unknown;
  };
  readonly diff: {
    workspaceDirtyStats(repositoryPath: string): Promise<FileDiffResult[]>;
  };
  // Resolves the anchor workspace's registry record (packet U3): the
  // card-view repo the pill/card currently displays, surfaced as a member.
  readonly repository: {
    getById(id: string): Promise<Repository | null>;
  };
}

export interface WorkspaceModelOptions {
  readonly refreshMs?: number;
}

// A manual "mark active" flag, remembering the agent session present at mark
// time so it can be cleared when a NEW session starts.
interface ActiveMark {
  readonly baselineSessionId?: string;
}

// Composes Lore signals (divergence, status, branch graph, per-file diff) and
// agent observability (session state + transcript intention) into a per-repo
// Mission Control snapshot: each workspace banded (awaiting review / in
// progress / idle) with attention reasons and card data. Emits a validated
// 'snapshot' on agent pushes, repository notifications, workspace lifecycle
// changes (provision/teardown), and a low-frequency refresh for the watched
// repository.
export class WorkspaceModelService extends EventEmitter {
  private readonly refreshMs: number;

  // instanceId -> mark. Persisted in-memory; cleared on a new agent session.
  private readonly marked = new Map<string, ActiveMark>();

  // instanceId -> last-seen workspace record, so markActive can resolve a
  // workspace (and its repo) from just an id.
  private readonly knownWorkspaces = new Map<string, Workspace>();

  private watchedRepositoryId: string | null = null;
  private refreshTimer: ReturnType<typeof global.setInterval> | null = null;

  // Serialization + coalescing state (C58): at most one snapshot build runs at
  // a time; triggers landing mid-build set the dirty flag and fold into a
  // single trailing rebuild. Snapshots therefore always emit in build-start
  // order — a slow build that observed OLD state can never overwrite a newer
  // snapshot — and the final emit always reflects the latest trigger.
  private buildInFlight = false;
  private buildQueued = false;

  private readonly onEvent = (): void => {
    void this.refresh();
  };

  constructor(
    private readonly log: MainLogger,
    private readonly deps: WorkspaceModelDeps,
    options: WorkspaceModelOptions = {}
  ) {
    super();
    this.refreshMs = options.refreshMs ?? WORKSPACE_MODEL_REFRESH_MS;
  }

  // Begin emitting snapshots for a repository: wire the agent/notification
  // event sources, start the low-frequency refresh timer, and emit an initial
  // snapshot. Idempotent; re-watching a different repo re-targets the model.
  watch(repositoryId: string): void {
    if (this.watchedRepositoryId === repositoryId) {
      return;
    }
    this.unwatch();
    this.watchedRepositoryId = repositoryId;
    this.deps.observer.on('push', this.onEvent);
    this.deps.lore.on('notification', this.onEvent);
    this.deps.workspaces.on('lifecycle', this.onEvent);
    this.refreshTimer = global.setInterval(this.onEvent, this.refreshMs);
    void this.refresh();
  }

  // Stop emitting and release every listener + timer (CLAUDE.md cleanup rule).
  unwatch(): void {
    if (this.refreshTimer !== null) {
      global.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.watchedRepositoryId !== null) {
      this.deps.observer.off('push', this.onEvent);
      this.deps.lore.off('notification', this.onEvent);
      this.deps.workspaces.off('lifecycle', this.onEvent);
      this.watchedRepositoryId = null;
    }
  }

  // Build (and cache) the current snapshot for a repository. Zod-validated
  // before returning, matching the push-channel discipline. Members are the
  // provisioned worktrees PLUS the anchor workspace (the card-view checkout
  // the pill/card displays) when it resolves — `workspaces.list` excludes the
  // anchor by design (packet U1); surfacing it is this packet's job.
  async snapshot(repositoryId: string): Promise<WorkspaceModelSnapshot> {
    const [workspaces, anchor] = await Promise.all([
      this.deps.workspaces.list(repositoryId),
      resolveAnchorWorkspace(this.log, this.deps, repositoryId),
    ]);
    // Sibling workspaces plus the anchor checkout, de-duplicated by resolved
    // path so a second same-repo record pointing at the anchor's own checkout
    // never surfaces it twice (see composeMembers).
    const members = composeMembers(workspaces, anchor);
    for (const workspace of members) {
      this.knownWorkspaces.set(workspace.instanceId, workspace);
    }
    const sessions = this.deps.observer.listSessions();
    const cards = await Promise.all(
      members.map(workspace =>
        this.buildCard(workspace, sessions, workspace.instanceId === anchor?.instanceId)
      )
    );
    cards.sort(compareCards);
    return WorkspaceModelSnapshotSchema.parse({ repositoryId, cards });
  }

  // Manually move an idle workspace to awaiting review (design 2a "mark
  // active"). Remembers the current session so the mark clears when a new one
  // starts. Resolves the workspace from the last-built snapshot's cache.
  async markActive(workspaceId: string): Promise<Workspace> {
    const workspace = this.knownWorkspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    const session = this.sessionFor(workspace.path, this.deps.observer.listSessions());
    this.marked.set(workspaceId, {
      ...(session ? { baselineSessionId: session.sessionId } : {}),
    });
    if (this.watchedRepositoryId === workspace.repositoryId) {
      void this.refresh();
    }
    return workspace;
  }

  // Manual refresh trigger (Mission Control header's refresh control).
  // Reuses the same immediate-refresh path the agent/notification/lifecycle
  // events and low-frequency timer use; a no-op if repositoryId isn't the one
  // currently watched.
  async refreshNow(repositoryId: string): Promise<void> {
    if (this.watchedRepositoryId !== repositoryId) {
      return;
    }
    await this.refresh();
  }

  // --- internals ------------------------------------------------------------

  // Rebuild and emit the watched repository's snapshot, serialized: while a
  // build is in flight a new trigger only marks the model dirty, and one
  // trailing rebuild runs once the current build finishes (N mid-build
  // triggers coalesce to one). Never throws into the event/timer callers.
  private async refresh(): Promise<void> {
    if (this.buildInFlight) {
      this.buildQueued = true;
      return;
    }
    this.buildInFlight = true;
    try {
      do {
        this.buildQueued = false;
        await this.buildAndEmit();
      } while (this.buildQueued);
    } finally {
      this.buildInFlight = false;
    }
  }

  // One snapshot build + emit for the currently watched repository. A failed
  // build is logged and the tick skipped.
  private async buildAndEmit(): Promise<void> {
    const repositoryId = this.watchedRepositoryId;
    if (repositoryId === null) {
      return;
    }
    try {
      const snapshot = await this.snapshot(repositoryId);
      this.emit('snapshot', snapshot);
    } catch (error) {
      this.log.error('Failed to build workspace snapshot', {
        error,
        operation: 'workspace-model:refresh',
        repositoryId,
      });
    }
  }

  private async buildCard(
    workspace: Workspace,
    sessions: AgentSessionRecord[],
    isActive: boolean
  ): Promise<WorkspaceCard> {
    const record = this.sessionFor(workspace.path, sessions);
    const markedActive = this.resolveMark(workspace, record);

    const [status, divergence, sessionCommits, dirtyStats, intention] = await Promise.all([
      this.safeStatus(workspace.path),
      this.safeDivergence(workspace.path),
      this.safeSessionCommits(workspace.path),
      this.safeDirtyStats(workspace.path),
      this.safeIntention(record),
    ]);

    const attention = deriveAttention({
      ...(record ? { sessionStatus: record.status } : {}),
      markedActive,
      uncommitted: isDirty(status),
      unpushed: divergence.state === 'ahead',
      diverged: divergence.state === 'behindOrDiverged',
      conflict: hasConflict(status),
      reviewableCommits: sessionCommits.length > 0,
    });

    const session = record ? toSessionState(record) : undefined;
    const lastEventAt = record?.lastEventAt ?? provisionedAtMs(workspace) ?? 0;

    return {
      workspace,
      attention,
      isActive,
      fileStats: aggregateStats(dirtyStats),
      changedFileCount: dirtyStats.length,
      sessionCommits,
      lastEventAt,
      ...(session ? { session } : {}),
      ...(intention ? { intention } : {}),
    };
  }

  // The workspace's current agent session: the record for this path with the
  // newest lastEventAt (a path may have hosted several sessions over time).
  private sessionFor(
    workspacePath: string,
    sessions: AgentSessionRecord[]
  ): AgentSessionRecord | undefined {
    let best: AgentSessionRecord | undefined;
    for (const record of sessions) {
      if (!samePath(record.workspacePath, workspacePath)) {
        continue;
      }
      if (!best || record.lastEventAt > best.lastEventAt) {
        best = record;
      }
    }
    return best;
  }

  // Whether the mark applies, clearing it when a new session has since started
  // (a different session id than the one present when marked).
  private resolveMark(workspace: Workspace, record: AgentSessionRecord | undefined): boolean {
    const mark = this.marked.get(workspace.instanceId);
    if (!mark) {
      return false;
    }
    if (record && record.sessionId !== mark.baselineSessionId) {
      this.marked.delete(workspace.instanceId);
      return false;
    }
    return true;
  }

  private async safeStatus(workspacePath: string): Promise<LoreFileStatusGroup> {
    try {
      return await this.deps.lore.getFileStatus(workspacePath);
    } catch (error) {
      logDegrade(this.log, 'status', workspacePath, error);
      return { untracked: [], unstaged: [], staged: [] };
    }
  }

  // The workspace checkout's remote divergence, straight from the SDK's
  // status flags (C27) — every card's workspace has its branch checked out,
  // so the current-branch answer is the right one. Degrades to 'unknown'.
  private async safeDivergence(workspacePath: string): Promise<BranchDivergence> {
    try {
      const status = await this.deps.lore.getWorkspaceRevisionStatus(workspacePath);
      return status?.divergence ?? { state: 'unknown', latest: '', latestRemote: '' };
    } catch (error) {
      logDegrade(this.log, 'divergence', workspacePath, error);
      return { state: 'unknown', latest: '', latestRemote: '' };
    }
  }

  // Session commits = the branch's own revisions since it diverged from its
  // parent (parent lineage excluded), newest-first, capped — the SDK's
  // onlyBranch history walk answers this directly (C23).
  private async safeSessionCommits(workspacePath: string): Promise<RevisionSummary[]> {
    try {
      return await this.deps.lore.getSessionCommits(workspacePath, SESSION_COMMITS_CAP);
    } catch (error) {
      logDegrade(this.log, 'sessionCommits', workspacePath, error);
      return [];
    }
  }

  private async safeDirtyStats(workspacePath: string): Promise<FileDiffResult[]> {
    try {
      return await this.deps.diff.workspaceDirtyStats(workspacePath);
    } catch (error) {
      logDegrade(this.log, 'dirtyStats', workspacePath, error);
      return [];
    }
  }

  private async safeIntention(
    record: AgentSessionRecord | undefined
  ): Promise<AgentIntention | undefined> {
    if (!record?.transcriptPath) {
      return undefined;
    }
    try {
      return await this.deps.transcript.extract(record.transcriptPath);
    } catch (error) {
      logDegrade(this.log, 'intention', record.workspacePath, error);
      return undefined;
    }
  }
}

function aggregateStats(diffs: FileDiffResult[]): LineStats {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    if (diff.lineStats) {
      added += diff.lineStats.added;
      removed += diff.lineStats.removed;
    }
  }
  return { added, removed };
}

// provisionedAt is a schema-validated ISO datetime, so Date.parse always
// yields a real epoch; absent means the timestamp was dropped (e.g. a restart).
function provisionedAtMs(workspace: Workspace): number | undefined {
  return workspace.provisionedAt ? Date.parse(workspace.provisionedAt) : undefined;
}

// Snapshot ordering: band (awaiting review, in progress, idle), then
// needs-you first, then most-recent activity.
function compareCards(a: WorkspaceCard, b: WorkspaceCard): number {
  const byBand = BAND_RANK[a.attention.band] - BAND_RANK[b.attention.band];
  if (byBand !== 0) {
    return byBand;
  }
  if (a.attention.needsYou !== b.attention.needsYou) {
    return a.attention.needsYou ? -1 : 1;
  }
  return b.lastEventAt - a.lastEventAt;
}
