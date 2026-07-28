import { RepositoryService } from '../services/repository';
import type { LoreRepositoryService } from '../services/lore-repository';
import type { DiffService } from '../services/diff-service';
import type { MergeService } from '../services/merge-service';
import { registerConfigHandlers } from './config-handlers';
import { registerRepositoryHandlers } from './repository-handlers';
import { registerLoreHandlers } from './lore-handlers';
import { registerDiffHandlers } from './diff-handlers';
import { registerMergeHandlers } from './merge-handlers';
import { registerWindowHandlers } from './window-handlers';
import { registerPathIpcHandlers } from './path-handlers';
import type { MainLogger } from './logger';

// Registers every IPC handler group; each group lives in its own module
export function registerIpcHandlers(
  log: MainLogger,
  repositoryService: RepositoryService,
  loreRepositoryService: LoreRepositoryService,
  diffService: DiffService,
  mergeService: MergeService
): void {
  registerConfigHandlers(log);
  registerRepositoryHandlers(log, repositoryService);
  registerLoreHandlers(log, loreRepositoryService);
  registerDiffHandlers(log, diffService);
  registerMergeHandlers(log, mergeService);
  registerWindowHandlers(log);
  registerPathIpcHandlers(log);
}
