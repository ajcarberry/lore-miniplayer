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
