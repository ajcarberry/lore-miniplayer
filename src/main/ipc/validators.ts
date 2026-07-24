import * as path from 'node:path';
import { z } from 'zod';
import {
  LoreSyncOptionsSchema,
  RepositorySchema,
  RepositoryCreateInputSchema,
  RepositoryUpdateInputSchema,
  WorkspaceProvisionRequestSchema,
  WorkspaceTeardownRequestSchema,
  WorkspaceMarkActiveRequestSchema,
  WorkspaceForgetRequestSchema,
  DiffRequestSchema,
  MergeStartRequestSchema,
  MergeResolveRequestSchema,
  MergeAbortRequestSchema,
  MergeCompleteRequestSchema,
  ResolveUserNameRequestSchema,
} from '../../shared/schemas';

export const ThemeModeSchema = z.enum(['auto', 'light', 'dark']);

export const WindowPositionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});

export const ConfigSchema = z.object({
  themeMode: ThemeModeSchema.optional(),
  windowPosition: WindowPositionSchema.optional(),
});

// Both fields share one message: it is what the renderer surfaces when a
// branch info/graph request payload is malformed in any way.
const invalidBranchRequest = 'Invalid repository path or branch';

export const BranchInfoRequestSchema = z.object({
  repositoryPath: z.string(invalidBranchRequest).min(1, invalidBranchRequest),
  branch: z.string(invalidBranchRequest).min(1, invalidBranchRequest),
});

export const BranchGraphRequestSchema = z.object({
  repositoryPath: z.string(invalidBranchRequest).min(1, invalidBranchRequest),
  branch: z.string(invalidBranchRequest).min(1, invalidBranchRequest),
});

// Path utility request schemas
export const PathJoinInputSchema = z.object({
  segments: z.array(z.string()).min(1, 'At least one path segment is required'),
});

export const PathBasenameInputSchema = z.object({
  path: z.string().min(1, 'Path is required'),
});

export type ValidatedConfig = z.infer<typeof ConfigSchema>;
export type ValidatedThemeMode = z.infer<typeof ThemeModeSchema>;
export type ValidatedWindowPosition = z.infer<typeof WindowPositionSchema>;
export type ValidatedBranchInfoRequest = z.infer<typeof BranchInfoRequestSchema>;
export type ValidatedBranchGraphRequest = z.infer<typeof BranchGraphRequestSchema>;

// Per-channel argument schemas for handleResult: each invoke channel's
// positional arguments are validated as one tuple, so the boundary has a
// single Zod contract per channel. Custom messages match what the renderer
// surfaces to the user on a validation failure.

const repositoryPathArg = z.string('Invalid repository path');

// config:*
export const ConfigGetArgsSchema = z.tuple([]);
export const ConfigSetArgsSchema = z.tuple([ConfigSchema]);

// repository:*
// The optional flag surfaces every registry origin (including provisioned
// worktrees) when true; omitted/false keeps the default card-view-only list.
export const RepositoryListArgsSchema = z.tuple([z.boolean().optional()]);
// The localPath is normalized to OS-specific separators before validation,
// so a denormalized-but-safe input (e.g. '/tmp//repos/../repos/a') passes
// the traversal check on its normalized form.
export const RepositoryCreateArgsSchema = z.tuple([
  RepositoryCreateInputSchema.extend({
    localPath: z
      .string('Local path is required')
      .transform(localPath => path.normalize(localPath))
      .pipe(RepositoryCreateInputSchema.shape.localPath),
  }),
]);
export const RepositoryUpdateArgsSchema = z.tuple([RepositoryUpdateInputSchema]);
export const RepositoryDeleteArgsSchema = z.tuple([z.string('Invalid repository ID')]);
export const RepositorySelectDirectoryArgsSchema = z.tuple([]);
export const RepositoryOpenInExplorerArgsSchema = z.tuple([z.string('Invalid path')]);

// window:open-terminal
export const WindowOpenTerminalArgsSchema = z.tuple([z.string('Invalid working directory')]);

// window:setNoticeActive
export const WindowNoticeActiveSchema = z.boolean();

// lore:* — channels taking only a repository (or local) path
export const LoreRepositoryPathArgsSchema = z.tuple([repositoryPathArg]);
export const LoreLocalPathArgsSchema = z.tuple([z.string('Invalid local path')]);

export const LoreListRemoteArgsSchema = z.tuple([
  z.string('Invalid server address').trim().min(1, 'Invalid server address'),
]);

export const LoreCloneArgsSchema = z.tuple([
  z.string('Invalid repository URL or local path'),
  z.string('Invalid repository URL or local path'),
]);

export const LoreSyncArgsSchema = z.tuple([
  repositoryPathArg,
  z.string('Invalid target branch').optional(),
  LoreSyncOptionsSchema.optional(),
]);

// Stage/unstage file paths are joined onto repositoryPath in the handler, so
// they must stay repository-relative: no absolute paths (either platform's
// form) and no parent-directory segments.
const repositoryRelativeFilePath = z
  .string('Invalid file paths')
  .min(1, 'Invalid file paths')
  .refine(
    filePath =>
      !path.isAbsolute(filePath) &&
      !path.win32.isAbsolute(filePath) &&
      !filePath.split(/[\\/]/).includes('..'),
    'Invalid file paths'
  );

export const LoreFilePathsArgsSchema = z.tuple([
  repositoryPathArg,
  z.array(repositoryRelativeFilePath, 'Invalid file paths'),
]);

export const LoreCommitArgsSchema = z.tuple([
  repositoryPathArg,
  z
    .string('Invalid commit message')
    .refine(message => message.trim().length > 0, 'Invalid commit message'),
]);

export const LoreBranchInfoArgsSchema = z.tuple([BranchInfoRequestSchema]);
export const LoreBranchGraphArgsSchema = z.tuple([BranchGraphRequestSchema]);

// path:*
export const PathJoinArgsSchema = z.tuple([PathJoinInputSchema]);
export const PathBasenameArgsSchema = z.tuple([PathBasenameInputSchema]);

// workspace:* — each channel double-validates its request with the P2
// contract schema (the renderer already validates before invoking).
export const WorkspaceProvisionArgsSchema = z.tuple([WorkspaceProvisionRequestSchema]);
export const WorkspaceTeardownArgsSchema = z.tuple([WorkspaceTeardownRequestSchema]);
export const WorkspaceMarkActiveArgsSchema = z.tuple([WorkspaceMarkActiveRequestSchema]);
export const WorkspaceForgetArgsSchema = z.tuple([WorkspaceForgetRequestSchema]);

// missionControl:* / workspace:model:* (P10) — the Mission Control window is
// opened for a repository (id optional: focuses an already-open window) and the
// workspace model is watched at a repository, returning its current snapshot.
// `refresh` (the header's manual refresh control) takes the same repository id
// as `watch`.
const repositoryIdArg = RepositorySchema.shape.id;
export const MissionControlOpenArgsSchema = z.tuple([repositoryIdArg.optional()]);
export const WorkspaceModelWatchArgsSchema = z.tuple([repositoryIdArg]);
export const WorkspaceModelRefreshArgsSchema = z.tuple([repositoryIdArg]);

// diff:* — the review window's compare picker
export const DiffCompareArgsSchema = z.tuple([DiffRequestSchema]);

// --- merge:* (P13) — the review window's merge workflow (design 2c) --------
// Each channel re-validates its request with the P2 contract schema.
export const MergeStartArgsSchema = z.tuple([MergeStartRequestSchema]);
export const MergeResolveArgsSchema = z.tuple([MergeResolveRequestSchema]);
export const MergeAbortArgsSchema = z.tuple([MergeAbortRequestSchema]);
export const MergeCompleteArgsSchema = z.tuple([MergeCompleteRequestSchema]);

// identity:resolveUserName — resolves a notification's userId to a display
// name (P5's LoreRepositoryService.resolveUserName).
export const ResolveUserNameArgsSchema = z.tuple([ResolveUserNameRequestSchema]);
