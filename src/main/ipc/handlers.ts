import { RepositoryService } from '../services/repository';
import type { LoreRepositoryService } from '../services/lore-repository';
import { registerConfigHandlers } from './config-handlers';
import { registerRepositoryHandlers } from './repository-handlers';
import { registerLoreHandlers } from './lore-handlers';
import { registerWindowHandlers } from './window-handlers';
import { registerPathIpcHandlers } from './path-handlers';
import type { MainLogger } from './logger';

// Registers every IPC handler group; each group lives in its own module
export function registerIpcHandlers(
  log: MainLogger,
  repositoryService: RepositoryService,
  loreRepositoryService: LoreRepositoryService
): void {
  registerConfigHandlers(log);
  registerRepositoryHandlers(log, repositoryService);
  registerLoreHandlers(log, loreRepositoryService);
  registerWindowHandlers(log);
  registerPathIpcHandlers(log);
}
