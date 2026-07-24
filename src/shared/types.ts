import type { z } from 'zod';
import type {
  RepositorySchema,
  WorkspaceOriginSchema,
  RepositoryCreateInputSchema,
  RepositoryUpdateInputSchema,
  LoreBranchSchema,
  LoreRepositoryStatusSchema,
  BranchDivergenceStateSchema,
  BranchDivergenceSchema,
  RepositoryNotificationSchema,
  CloneProgressSchema,
  LoreSyncOptionsSchema,
  RevisionSummarySchema,
  BranchGraphLaneSchema,
  BranchGraphParentLaneSchema,
  MergeFromParentSchema,
  MergeToParentSchema,
  BranchGraphSchema,
  WorkspaceSchema,
  WorkspaceBandSchema,
  WorkspaceAttentionReasonSchema,
  WorkspaceAttentionSchema,
  AgentSessionStatusSchema,
  AgentSessionStateSchema,
  AgentTaskStatusSchema,
  AgentTaskSchema,
  AgentCommentaryEntrySchema,
  AgentIntentionSchema,
  AgentObservabilityPushSchema,
  FileDiffActionSchema,
  LineStatsSchema,
  FileDiffResultSchema,
  CompareTargetSchema,
  MergeFileResolutionSchema,
  MergeFileStateSchema,
  MergeStateSchema,
  ReviewWorkflowModeSchema,
  ReviewCompareSchema,
  ReviewOpenRequestSchema,
  WorkspaceCardSchema,
  WorkspaceModelSnapshotSchema,
  WorkspaceProvisionRequestSchema,
  WorkspaceTeardownRequestSchema,
  WorkspaceTeardownResultSchema,
  WorkspaceMarkActiveRequestSchema,
  WorkspaceForgetRequestSchema,
  DiffRequestSchema,
  MergeStartRequestSchema,
  MergeResolveRequestSchema,
  MergeAbortRequestSchema,
  MergeCompleteRequestSchema,
  ResolveUserNameRequestSchema,
} from './schemas';

export type ThemeMode = 'auto' | 'light' | 'dark';

export interface Config {
  themeMode?: ThemeMode;
  windowPosition?: { x: number; y: number };
}

// Lore Repository types
export type LoreBranch = z.infer<typeof LoreBranchSchema>;

export type LoreRepositoryStatus = z.infer<typeof LoreRepositoryStatusSchema>;

// Branch divergence state derived from BRANCH_INFO's latest/latestRemote
// hashes, refined with direction. BRANCH_INFO itself carries no ordering
// information, but direction is derivable locally: when the hashes differ,
// walking local `revisionHistory` for `latestRemote` distinguishes ahead
// (found — local has commits the remote doesn't yet have) from
// behindOrDiverged (not found — the remote has moved on, whether purely
// ahead of local or on a separate lineage; either way the user's next
// action is Sync). `unknown` covers a missing/empty/zero hash on either
// side.
export type BranchDivergenceState = z.infer<typeof BranchDivergenceStateSchema>;

export type BranchDivergence = z.infer<typeof BranchDivergenceSchema>;

// Server push notification kinds the app reacts to, forwarded from the
// SDK's notificationSubscribe stream (lock/unlock events are ignored).
export type RepositoryNotification = z.infer<typeof RepositoryNotificationSchema>;

export type RepositoryNotificationKind = RepositoryNotification['kind'];

// Clone progress pushed from the main process while a repositoryClone
// streams, keyed by the clone's destination path.
export type CloneProgress = z.infer<typeof CloneProgressSchema>;

// Revision history entry. The SDK's `REVISION_HISTORY_ENTRY` event carries
// only `revision`/`revisionNumber`/`parent`; `message` and `timestamp` are
// optional because they are enriched afterward from the METADATA events a
// follow-up `revisionInfo` call streams, and that enrichment degrades to
// hash-only entries on failure.
export type RevisionSummary = z.infer<typeof RevisionSummarySchema>;

// One lane of the branch graph: a named branch and its revisions
// (newest-first, matching the SDK's parent-pointer walk order).
export type BranchGraphLane = z.infer<typeof BranchGraphLaneSchema>;

// The parent lane additionally carries the branch point — the revision on
// the parent branch where the current branch was created.
export type BranchGraphParentLane = z.infer<typeof BranchGraphParentLaneSchema>;

// A merge accepted into the child branch from the parent: the child
// merge-revision hash, and the parent-lineage hash it merged in (the raw
// history entry's `parent[1]`) — the true source node the merge connector
// must anchor to in the two-lane constellation view.
export type MergeFromParent = z.infer<typeof MergeFromParentSchema>;

// A merge accepted into the parent branch from the child: the parent
// merge-revision hash, and the child-lineage hash it merged in (the raw
// history entry's `parent[1]`) — the true source node the rising merge
// connector must anchor to in the two-lane constellation view.
export type MergeToParent = z.infer<typeof MergeToParentSchema>;

// The full branch-graph ledger for a branch. `current` is the working
// copy's revision hash (empty when unknown). `branch` is the current
// branch's full lineage; `parent` (when the branch has a resolvable parent)
// is the parent branch's lineage plus the branch point. `mergesFromParent`
// lists each child merge-revision paired with its true parent-lineage
// source — merges accepted into the child from the parent.
export type BranchGraph = z.infer<typeof BranchGraphSchema>;

// The unified workspace-registry model (packet U1). Named `Repository` for
// renderer compatibility this pass; U2 renames it to `Workspace`.
export type Repository = z.infer<typeof RepositorySchema>;

// How a workspace entry came to exist: `attached` (existing folder tracked),
// `cloned` (card-view clone), `provisioned` (Mission Control worktree).
export type WorkspaceOrigin = z.infer<typeof WorkspaceOriginSchema>;

export type RepositoryCreateInput = z.infer<typeof RepositoryCreateInputSchema>;

export type RepositoryUpdateInput = z.infer<typeof RepositoryUpdateInputSchema>;

// Lore Sync Options
export type LoreSyncOptions = z.infer<typeof LoreSyncOptionsSchema>;

// Lore File Status types. The conflict-state fields mirror the SDK's
// flagConflict* flags (REPOSITORY_STATUS_FILE), mapped at the one existing
// producer (src/main/services/lore-repository.ts). `conflict` is always
// reported; the other conflict* fields stay optional/false-shaped
// sub-states of a conflict (unresolved, automerged, resolved mine/theirs).
export interface LoreFileStatus {
  readonly path: string;
  readonly isUntracked: boolean;
  readonly isStaged: boolean;
  readonly conflict: boolean;
  readonly conflictUnresolved?: boolean;
  readonly conflictAutomerged?: boolean;
  readonly conflictMine?: boolean;
  readonly conflictTheirs?: boolean;
}

export interface LoreFileStatusGroup {
  readonly untracked: LoreFileStatus[];
  readonly unstaged: LoreFileStatus[];
  readonly staged: LoreFileStatus[];
}

// Result pattern for IPC communication
export type Result<T> = { success: true; data: T } | { success: false; error: string };

// Helper type for void results
export type VoidResult = Result<void>;

// Path utility types
export interface PathValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly normalizedPath?: string;
}

// ---------------------------------------------------------------------------
// Agentic development: workspace lifecycle, agent observability, diff/merge
// review, and collaborator signals (Mission Control + Review window).
// ---------------------------------------------------------------------------

export type Workspace = z.infer<typeof WorkspaceSchema>;

export type WorkspaceBand = z.infer<typeof WorkspaceBandSchema>;

export type WorkspaceAttentionReason = z.infer<typeof WorkspaceAttentionReasonSchema>;

export type WorkspaceAttention = z.infer<typeof WorkspaceAttentionSchema>;

export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;

export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;

export type AgentTask = z.infer<typeof AgentTaskSchema>;

export type AgentCommentaryEntry = z.infer<typeof AgentCommentaryEntrySchema>;

export type AgentIntention = z.infer<typeof AgentIntentionSchema>;

// The agent observer's 'push' payload (consumed in-main by the workspace model).
export type AgentObservabilityPush = z.infer<typeof AgentObservabilityPushSchema>;

export type FileDiffAction = z.infer<typeof FileDiffActionSchema>;

export type LineStats = z.infer<typeof LineStatsSchema>;

export type FileDiffResult = z.infer<typeof FileDiffResultSchema>;

export type CompareTarget = z.infer<typeof CompareTargetSchema>;

export type MergeFileResolution = z.infer<typeof MergeFileResolutionSchema>;

export type MergeFileState = z.infer<typeof MergeFileStateSchema>;

export type MergeState = z.infer<typeof MergeStateSchema>;

// Which contextual primary action the review window's bottom bar shows.
export type ReviewWorkflowMode = z.infer<typeof ReviewWorkflowModeSchema>;

// The review window's compare picker selection and the full open-review
// request Mission Control emits (P11).
export type ReviewCompare = z.infer<typeof ReviewCompareSchema>;

export type ReviewOpenRequest = z.infer<typeof ReviewOpenRequestSchema>;

// Mission Control's per-workspace card and the per-repository snapshot the
// workspace model (P9) composes from Lore signals + agent observability.
export type WorkspaceCard = z.infer<typeof WorkspaceCardSchema>;

export type WorkspaceModelSnapshot = z.infer<typeof WorkspaceModelSnapshotSchema>;

// IPC request/response payload types (the `T` inside each channel's
// `Result<T>`; see IPC_CHANNELS in schemas.ts for the channel names).
// Requests are inferred from their boundary-validated Zod schemas; responses
// are plain aliases of the underlying result types (nothing parses a
// response at runtime).
export type WorkspaceProvisionRequest = z.infer<typeof WorkspaceProvisionRequestSchema>;
export type WorkspaceProvisionResponse = Workspace;

export type WorkspaceTeardownRequest = z.infer<typeof WorkspaceTeardownRequestSchema>;
export type WorkspaceTeardownResult = z.infer<typeof WorkspaceTeardownResultSchema>;
export type WorkspaceTeardownResponse = WorkspaceTeardownResult;

export type WorkspaceMarkActiveRequest = z.infer<typeof WorkspaceMarkActiveRequestSchema>;
export type WorkspaceMarkActiveResponse = Workspace;

export type WorkspaceForgetRequest = z.infer<typeof WorkspaceForgetRequestSchema>;

export type DiffRequest = z.infer<typeof DiffRequestSchema>;
export type DiffResponse = FileDiffResult[];

export type MergeStartRequest = z.infer<typeof MergeStartRequestSchema>;
export type MergeStartResponse = MergeState;

export type MergeResolveRequest = z.infer<typeof MergeResolveRequestSchema>;
export type MergeResolveResponse = MergeState;

export type MergeAbortRequest = z.infer<typeof MergeAbortRequestSchema>;
export type MergeAbortResponse = { aborted: boolean };

export type MergeCompleteRequest = z.infer<typeof MergeCompleteRequestSchema>;
export type MergeCompleteResponse = { revision: string };

export type ResolveUserNameRequest = z.infer<typeof ResolveUserNameRequestSchema>;
export type ResolveUserNameResponse = { name: string };
