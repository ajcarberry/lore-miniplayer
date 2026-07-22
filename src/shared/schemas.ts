import { z } from 'zod';
import { ACCENT_HUE_VALUES } from './accent';

export const AccentHueSchema = z.number().refine(hue => ACCENT_HUE_VALUES.includes(hue), {
  message: 'accentHue must be one of the defined Lore accent hues',
});

export const RepositorySchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .min(1, 'Repository name is required')
    .max(100, 'Repository name is too long')
    .regex(/^[a-zA-Z0-9\s\-_.]+$/, 'Repository name contains invalid characters'),
  url: z
    .string()
    .min(1, 'Repository URL is required')
    .refine(url => {
      // Allow Lore scheme URLs: lore:// (plaintext) and lores:// (TLS),
      // plus the legacy grpc(s):// scheme variants
      const loreSchemePattern = /^(lores?|grpcs?):\/\/[a-zA-Z0-9.-]+(:\d+)?\/[a-zA-Z0-9_\-./]+$/;
      // Allow Lore format without a scheme: domain.name/repository
      const lorePattern = /^[a-zA-Z0-9.-]+\.[a-zA-Z]+\/[a-zA-Z0-9_\-./]+$/;
      // Allow local repository placeholder for existing repos
      const localPattern = /^local:\/\//;

      return loreSchemePattern.test(url) || lorePattern.test(url) || localPattern.test(url);
    }, 'URL must be a Lore repository URL (lore://host/repo, lores://host/repo, or host/repo)'),
  localPath: z
    .string()
    .min(1, 'Local path is required')
    .refine(path => !path.includes('..'), 'Path traversal not allowed')
    .refine(path => {
      // Check for absolute path: Unix starts with '/', Windows starts with drive letter (C:)
      return path.startsWith('/') || /^[A-Za-z]:/.test(path);
    }, 'Must be an absolute path'),
  accentHue: AccentHueSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const RepositoryCreateInputSchema = z.object({
  name: RepositorySchema.shape.name,
  url: RepositorySchema.shape.url,
  localPath: RepositorySchema.shape.localPath,
});

export const RepositoryUpdateInputSchema = z.object({
  id: RepositorySchema.shape.id,
  name: RepositorySchema.shape.name.optional(),
  url: RepositorySchema.shape.url.optional(),
  localPath: RepositorySchema.shape.localPath.optional(),
  accentHue: RepositorySchema.shape.accentHue.optional(),
});

// Options accepted by lore:repository:sync; unknown keys are stripped by
// Zod's default object behavior when the IPC boundary parses the payload.
export const LoreSyncOptionsSchema = z.object({
  revision: z.string().optional(),
  forwardChanges: z.boolean().optional(),
  reset: z.boolean().optional(),
  force: z.boolean().optional(),
});

// Lore Repository schemas
export const LoreBranchSchema = z.object({
  name: z.string(),
  isDefault: z.boolean(),
  isCurrent: z.boolean(),
});

export const LoreRepositoryStatusSchema = z.object({
  exists: z.boolean(),
  isLoreRepo: z.boolean(),
});

export const BranchDivergenceStateSchema = z.enum([
  'inSync',
  'ahead',
  'behindOrDiverged',
  'unknown',
]);

export const BranchDivergenceSchema = z.object({
  state: BranchDivergenceStateSchema,
  latest: z.string(),
  latestRemote: z.string(),
});

export const RepositoryNotificationSchema = z.object({
  repositoryPath: z.string().min(1),
  kind: z.enum([
    'branchPushed',
    'branchCreated',
    'branchDeleted',
    'resourceLocked',
    'resourceUnlocked',
  ]),
  // Populated on branchPushed (attribution toast) and the lock kinds
  // (who locked/unlocked); absent on branchCreated/branchDeleted.
  userId: z.string().min(1).optional(),
  // Populated on the lock kinds only, mirroring
  // LoreNotificationResourceLocked/UnlockedEventData.
  branch: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
});

export const CloneProgressSchema = z.object({
  localPath: z.string().min(1),
  percent: z.number().min(0).max(100),
});

export const RevisionSummarySchema = z.object({
  revision: z.string(),
  revisionNumber: z.number(),
  message: z.string().optional(),
  timestamp: z.number().optional(),
});

export const BranchGraphLaneSchema = z.object({
  name: z.string(),
  revisions: z.array(RevisionSummarySchema),
});

export const BranchGraphParentLaneSchema = BranchGraphLaneSchema.extend({
  branchPoint: z.string(),
});

export const MergeFromParentSchema = z.object({
  child: z.string(),
  parentSource: z.string(),
});

export const MergeToParentSchema = z.object({
  parent: z.string(),
  childSource: z.string(),
});

export const BranchGraphSchema = z.object({
  current: z.string(),
  branch: BranchGraphLaneSchema,
  parent: BranchGraphParentLaneSchema.optional(),
  mergesFromParent: z.array(MergeFromParentSchema),
  mergesToParent: z.array(MergeToParentSchema),
});

// ---------------------------------------------------------------------------
// Agentic development: workspace lifecycle, agent observability, diff/merge
// review, and collaborator signals (Mission Control + Review window).
// ---------------------------------------------------------------------------

// A Lore shared-store instance (repositoryInstanceList — instanceId, path,
// branchName, revision, stale) checked out for one agent or manual
// workspace, enriched with the app's own repository link and provisioning
// timestamp.
export const WorkspaceSchema = z.object({
  instanceId: z.string().min(1),
  path: z.string().min(1),
  branchName: z.string().min(1),
  revision: z.string(),
  stale: z.boolean(),
  repositoryId: RepositorySchema.shape.id,
  provisionedAt: z.string().datetime().optional(),
});

// Mission Control's three bands (design 2a): awaiting review leads, in
// progress shows live task machinery, idle is minimized until reactivated.
export const WorkspaceBandSchema = z.enum(['awaitingReview', 'inProgress', 'idle']);

export const WorkspaceAttentionReasonSchema = z.enum([
  'permissionPrompt',
  'idlePrompt',
  'reviewReady',
  'conflict',
  'diverged',
  'unpushed',
  'uncommitted',
]);

export const WorkspaceAttentionSchema = z.object({
  band: WorkspaceBandSchema,
  needsYou: z.boolean(),
  reasons: z.array(WorkspaceAttentionReasonSchema),
});

// Agent observability (research note): hook-driven session lifecycle state.
export const AgentSessionStatusSchema = z.enum(['active', 'waitingOnUser', 'stopped', 'ended']);

export const AgentSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
  status: AgentSessionStatusSchema,
  lastEventAt: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});

export const AgentTaskStatusSchema = z.enum(['pending', 'running', 'done']);

export const AgentTaskSchema = z.object({
  subject: z.string().min(1),
  status: AgentTaskStatusSchema,
  runningElapsedMs: z.number().nonnegative().optional(),
});

export const AgentCommentaryEntrySchema = z.object({
  at: z.number().nonnegative(),
  text: z.string().min(1),
});

// Transcript-derived intention (feature-flagged, P8): what the agent was
// asked, its task list, and its own narrative account, shown beside the
// diff in the review window (design 2b/2c).
export const AgentIntentionSchema = z.object({
  prompt: z.string().optional(),
  title: z.string().optional(),
  tasks: z.array(AgentTaskSchema),
  commentary: z.array(AgentCommentaryEntrySchema),
  summary: z.string().optional(),
  sessionId: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
});

// Push channel payload (main -> renderer): agent session and intention
// updates share one channel, discriminated by kind.
export const AgentObservabilityPushSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sessionState'), state: AgentSessionStateSchema }),
  z.object({
    kind: z.literal('intention'),
    workspacePath: z.string().min(1),
    intention: AgentIntentionSchema,
  }),
]);

// Per-file diff result (fileDiff / fileDump fallback), rendered in the
// review window's center pane.
export const FileDiffActionSchema = z.enum(['added', 'modified', 'deleted', 'moved']);

export const LineStatsSchema = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});

export const FileDiffResultSchema = z.object({
  path: z.string().min(1),
  action: FileDiffActionSchema,
  patch: z.string().optional(),
  binary: z.boolean(),
  truncated: z.boolean(),
  lineStats: LineStatsSchema.optional(),
});

// The review window's compare picker: a revision, the working tree, or a
// branch's head.
export const CompareTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision'), revision: z.string().min(1) }),
  z.object({ kind: z.literal('workingTree') }),
  z.object({ kind: z.literal('branchHead'), branch: z.string().min(1) }),
]);

// Merge workflow (design 2c): per-file resolution state (v1 ships per-file
// granularity — see the spec's merge-conflict-materialization open
// question).
export const MergeFileResolutionSchema = z.enum(['mine', 'theirs']);

export const MergeFileStateSchema = z.object({
  path: z.string().min(1),
  state: z.enum(['merged', 'conflict']),
  resolution: MergeFileResolutionSchema.optional(),
});

export const MergeStateSchema = z.object({
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  files: z.array(MergeFileStateSchema),
  allResolved: z.boolean(),
});

// Which contextual primary action the review window's bottom bar shows.
export const ReviewWorkflowModeSchema = z.enum(['commit', 'merge']);

// The review window's initial compare picker selection (design 2b: a source
// revision on the left, a target on the right — a later revision or the
// working tree).
export const ReviewCompareSchema = z.object({
  source: CompareTargetSchema,
  target: CompareTargetSchema,
});

// The typed "open the review window" request Mission Control's Review / Commit
// / Merge buttons emit (P11): the workspace checkout to review (its `path` is
// the repositoryPath every diff/status/stage/commit IPC call targets), the
// branch under review, the workflow that fixes the bottom bar's one contextual
// action, and the compare picker's preloaded selection.
export const ReviewOpenRequestSchema = z.object({
  workspacePath: z.string().min(1),
  repositoryId: RepositorySchema.shape.id,
  branchName: z.string().min(1),
  revision: z.string(),
  workflow: ReviewWorkflowModeSchema,
  compare: ReviewCompareSchema,
  title: z.string().optional(),
});

// Mission Control's per-workspace card (design 2a): the workspace, its
// derived attention (band + reasons), the live agent session (when observed),
// the transcript-derived intention (when enriched), aggregate +/- line stats
// and changed-file count against the branch's parent, and the session commits
// on the branch since provisioning (the branch's own revisions, parent
// lineage excluded). `lastEventAt` drives recent-ordering within a band.
export const WorkspaceCardSchema = z.object({
  workspace: WorkspaceSchema,
  attention: WorkspaceAttentionSchema,
  session: AgentSessionStateSchema.optional(),
  intention: AgentIntentionSchema.optional(),
  fileStats: LineStatsSchema,
  changedFileCount: z.number().int().nonnegative(),
  sessionCommits: z.array(RevisionSummarySchema),
  lastEventAt: z.number().nonnegative(),
});

// A per-repository Mission Control snapshot: every workspace card for the
// selected repo, pre-sorted (awaiting review, then in progress, then idle;
// within a band, workspaces needing you first, then most-recent activity).
// The workspace model emits it on agent/notification events and a
// low-frequency refresh, Zod-validated before it leaves the main process.
export const WorkspaceModelSnapshotSchema = z.object({
  repositoryId: RepositorySchema.shape.id,
  cards: z.array(WorkspaceCardSchema),
});

// --- IPC request/response payloads ------------------------------------------

export const WorkspaceProvisionRequestSchema = z.object({
  repositoryId: RepositorySchema.shape.id,
  branchName: z.string().min(1, 'Branch name is required'),
});
export const WorkspaceProvisionResponseSchema = WorkspaceSchema;

export const WorkspaceListRequestSchema = z.object({
  repositoryId: RepositorySchema.shape.id,
});
export const WorkspaceListResponseSchema = z.array(WorkspaceSchema);

// Destructive (worktree directory + local/remote branch removal); the
// workspace is identified by either its instance id or its worktree path.
export const WorkspaceTeardownRequestSchema = z.union([
  z.object({ workspaceId: z.string().min(1), force: z.boolean() }),
  z.object({ path: z.string().min(1), force: z.boolean() }),
]);

export const WorkspaceTeardownResultSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  directoryRemoved: z.boolean(),
  localBranchRemoved: z.boolean(),
  remoteBranchRemoved: z.boolean(),
});
export const WorkspaceTeardownResponseSchema = WorkspaceTeardownResultSchema;

export const WorkspaceMarkActiveRequestSchema = z.object({
  workspaceId: z.string().min(1),
});
export const WorkspaceMarkActiveResponseSchema = WorkspaceSchema;

export const DiffRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  source: CompareTargetSchema,
  target: CompareTargetSchema,
  paths: z.array(z.string().min(1)).optional(),
});
export const DiffResponseSchema = z.array(FileDiffResultSchema);

export const MergeStartRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
});
export const MergeStartResponseSchema = MergeStateSchema;

export const MergeResolveRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  path: z.string().min(1),
  resolution: MergeFileResolutionSchema,
});
export const MergeResolveResponseSchema = MergeStateSchema;

export const MergeAbortRequestSchema = z.object({
  repositoryPath: z.string().min(1),
});
export const MergeAbortResponseSchema = z.object({ aborted: z.boolean() });

export const MergeCompleteRequestSchema = z.object({
  repositoryPath: z.string().min(1),
});
export const MergeCompleteResponseSchema = z.object({
  revision: z.string().min(1),
});

export const LockEntrySchema = z.object({
  path: z.string().min(1),
  userId: z.string().min(1),
  branch: z.string().min(1),
});

export const LockQueryRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  paths: z.array(z.string().min(1)).optional(),
});
export const LockQueryResponseSchema = z.array(LockEntrySchema);

export const LockReleaseRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1, 'At least one path is required'),
});
export const LockReleaseResponseSchema = z.object({
  released: z.array(z.string().min(1)),
});

// Resolves a notification's raw `userId` to a display name (P5's
// LoreRepositoryService.resolveUserName, exposed to the renderer so the
// attribution toast can show a name instead of a raw id). Server-dependent
// (P1c): offline/no-auth-endpoint requests are reported as a failure result,
// never a fabricated name.
export const ResolveUserNameRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  userId: z.string().min(1),
});
export const ResolveUserNameResponseSchema = z.object({
  name: z.string().min(1),
});

// IPC channel names, grouped by domain and colon-namespaced to match the
// existing 'lore:...' channels declared at their call sites in preload.ts /
// lore-handlers.ts. `agent.observability` is the one push channel
// (main -> renderer); every other channel is request/response (invoke).
export const IPC_CHANNELS = {
  workspace: {
    provision: 'workspace:provision',
    list: 'workspace:list',
    teardown: 'workspace:teardown',
    markActive: 'workspace:markActive',
  },
  diff: {
    compare: 'diff:compare',
  },
  merge: {
    start: 'merge:start',
    resolve: 'merge:resolve',
    abort: 'merge:abort',
    complete: 'merge:complete',
  },
  locks: {
    query: 'locks:query',
    release: 'locks:release',
  },
  // Attribution name resolution (P5's resolveUserName, exposed for the P15
  // toast). One request/response invoke; no push involved.
  identity: {
    resolveUserName: 'identity:resolveUserName',
  },
  agent: {
    observability: 'agent:observability',
  },
  // Mission Control window (P10, design 2a). `open`/`close` manage the
  // secondary window; `watch` (invoke) targets the workspace model at a repo
  // and returns its current snapshot; `snapshot` is the one-way push the model
  // emits on every rebuild (Zod-validated in the renderer before use).
  missionControl: {
    open: 'missionControl:open',
    close: 'missionControl:close',
  },
  workspaceModel: {
    watch: 'workspace:model:watch',
    snapshot: 'workspace:model:snapshot',
  },
  // Review window (P11, design 2b/2c). `open` (send) creates or focuses the
  // per-workspace window with its targets + workflow preloaded;
  // `requestContext` (invoke) lets the window pull its open request on mount;
  // `context` is the one-way push re-delivered when an already-open window is
  // re-targeted (e.g. Merge pressed while its commit review is open).
  review: {
    open: 'review:open',
    requestContext: 'review:requestContext',
    context: 'review:context',
  },
} as const;
