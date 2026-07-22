import { RepositoryService } from '../services/repository';
import type { LoreRepositoryService } from '../services/lore-repository';
import type { WorkspaceService } from '../services/workspace-service';
import { registerConfigHandlers } from './config-handlers';
import { registerRepositoryHandlers } from './repository-handlers';
import { registerLoreHandlers } from './lore-handlers';
import { registerWorkspaceHandlers } from './workspace-handlers';
import { registerWindowHandlers } from './window-handlers';
import { registerPathIpcHandlers } from './path-handlers';
import type { MainLogger } from './logger';

// Registers every IPC handler group; each group lives in its own module
export function registerIpcHandlers(
  log: MainLogger,
  repositoryService: RepositoryService,
  loreRepositoryService: LoreRepositoryService,
  workspaceService: WorkspaceService
): void {
  registerConfigHandlers(log);
  registerRepositoryHandlers(log, repositoryService);
  registerLoreHandlers(log, loreRepositoryService);
  registerWorkspaceHandlers(log, workspaceService);
  registerWindowHandlers(log);
  registerPathIpcHandlers(log);
}
