import { RepositoryService } from '../services/repository';
import type { LoreRepositoryService } from '../services/lore-repository';
import type { WorkspaceService } from '../services/workspace-service';
import type { WorkspaceModelService } from '../services/workspace-model';
import type { DiffService } from '../services/diff-service';
import type { MergeService } from '../services/merge-service';
import type { LockService } from '../services/lock-service';
import { registerConfigHandlers } from './config-handlers';
import { registerRepositoryHandlers } from './repository-handlers';
import { registerLoreHandlers } from './lore-handlers';
import { registerWorkspaceHandlers } from './workspace-handlers';
import { registerDiffHandlers } from './diff-handlers';
import { registerMergeHandlers } from './merge-handlers';
import { registerLockHandlers } from './lock-handlers';
import { registerWindowHandlers } from './window-handlers';
import { registerPathIpcHandlers } from './path-handlers';
import type { MainLogger } from './logger';

// Registers every IPC handler group; each group lives in its own module
export function registerIpcHandlers(
  log: MainLogger,
  repositoryService: RepositoryService,
  loreRepositoryService: LoreRepositoryService,
  workspaceService: WorkspaceService,
  workspaceModel: WorkspaceModelService,
  diffService: DiffService,
  mergeService: MergeService,
  lockService: LockService
): void {
  registerConfigHandlers(log);
  registerRepositoryHandlers(log, repositoryService);
  registerLoreHandlers(log, loreRepositoryService);
  registerWorkspaceHandlers(log, workspaceService, workspaceModel);
  registerDiffHandlers(log, diffService);
  registerMergeHandlers(log, mergeService);
  registerLockHandlers(log, lockService);
  registerWindowHandlers(log);
  registerPathIpcHandlers(log);
}
