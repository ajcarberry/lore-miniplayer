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
  kind: z.enum(['branchPushed', 'branchCreated', 'branchDeleted']),
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
// Project View: diff/merge review of the working directory (commit and merge
// workflows).
// ---------------------------------------------------------------------------

// Per-file diff result (fileDiff), rendered in the Project View's center
// pane.
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

// The Project View's compare picker: a revision, the working tree, or a
// branch's head.
export const CompareTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision'), revision: z.string().min(1) }),
  z.object({ kind: z.literal('workingTree') }),
  z.object({ kind: z.literal('branchHead'), branch: z.string().min(1) }),
]);

// Merge workflow: per-file resolution state (v1 ships per-file granularity).
export const MergeFileResolutionSchema = z.enum(['mine', 'theirs']);

export const MergeFileStateSchema = z.object({
  path: z.string().min(1),
  state: z.enum(['merged', 'conflict']),
  resolution: MergeFileResolutionSchema.optional(),
});

export const MergeStateSchema = z.object({
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  // The revision of the target branch that the merge actually brought in — the
  // branch's REMOTE tip, which is what `branchMergeStart` merges. BRANCH_INFO's
  // `latest` names the LOCAL store's tip of a branch that isn't checked out,
  // and that lags whatever another client has pushed since. Consumers that want
  // to show "theirs" must diff against THIS revision, not the branch head, or
  // they show the pre-merge base content instead of what really conflicted.
  targetRevision: z.string(),
  files: z.array(MergeFileStateSchema),
  allResolved: z.boolean(),
  // Whether the source branch has revisions the target lacks — i.e. the merge
  // would actually land something. This is NOT implied by `files`: when the
  // target has not moved since the branch diverged, phase 1 (merging the target
  // into the branch) legitimately reports no conflicts and no auto-merges, yet
  // the branch's own commits still need to land. Distinguishes "ahead, nothing
  // to reconcile — ready to land" (true) from "branch tip already on the target
  // — nothing to merge" (false).
  hasChangesToLand: z.boolean(),
});

// Which contextual primary action the Project View's bottom bar shows.
export const ReviewWorkflowModeSchema = z.enum(['commit', 'merge']);

// The Project View's initial compare picker selection: a source revision on
// the left, a target on the right — a later revision or the working tree.
export const ReviewCompareSchema = z.object({
  source: CompareTargetSchema,
  target: CompareTargetSchema,
});

// The typed "open the review view" request the card's Review / Merge actions
// emit (openReview.ts): the repository to review (its `repositoryPath` is
// what every diff/status/stage/commit IPC call targets), the branch under
// review, the workflow that fixes the bottom bar's one contextual action, and
// the compare picker's preloaded selection. Stays in the renderer — the card
// morphs into the review surface in place.
export const ReviewOpenRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  repositoryId: RepositorySchema.shape.id,
  // Carried for the header eyebrow, so the view never refetches the
  // repository list just to recover a name the opener already had.
  repositoryName: RepositorySchema.shape.name,
  branchName: z.string().min(1),
  // The merge workflow's landing target (also the switcher's merge target).
  targetBranch: z.string().min(1),
  workflow: ReviewWorkflowModeSchema,
  compare: ReviewCompareSchema,
});

// --- IPC request/response payloads ------------------------------------------

export const DiffRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  source: CompareTargetSchema,
  target: CompareTargetSchema,
  paths: z.array(z.string().min(1)).optional(),
});

export const MergeStartRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
});

export const MergeResolveRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  path: z.string().min(1),
  resolution: MergeFileResolutionSchema,
});

export const MergeAbortRequestSchema = z.object({
  repositoryPath: z.string().min(1),
});

export const MergeCompleteRequestSchema = z.object({
  repositoryPath: z.string().min(1),
});

// IPC channel names, grouped by domain and colon-namespaced to match the
// existing 'lore:...' channels declared at their call sites in preload.ts /
// lore-handlers.ts. Every channel is request/response (invoke).
export const IPC_CHANNELS = {
  diff: {
    compare: 'diff:compare',
  },
  merge: {
    start: 'merge:start',
    resolve: 'merge:resolve',
    abort: 'merge:abort',
    complete: 'merge:complete',
  },
} as const;
