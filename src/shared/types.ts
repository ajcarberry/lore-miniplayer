import type { z } from 'zod';
import type {
  RepositorySchema,
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

export type Repository = z.infer<typeof RepositorySchema>;

export type RepositoryCreateInput = z.infer<typeof RepositoryCreateInputSchema>;

export type RepositoryUpdateInput = z.infer<typeof RepositoryUpdateInputSchema>;

// Lore Sync Options
export type LoreSyncOptions = z.infer<typeof LoreSyncOptionsSchema>;

// Lore File Status types
export interface LoreFileStatus {
  readonly path: string;
  readonly isUntracked: boolean;
  readonly isStaged: boolean;
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
