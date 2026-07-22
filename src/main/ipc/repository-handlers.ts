import { dialog, shell } from 'electron';
import type { RepositoryService } from '../services/repository';
import { handleResult } from './result-helpers';
import {
  RepositoryListArgsSchema,
  RepositoryCreateArgsSchema,
  RepositoryUpdateArgsSchema,
  RepositoryDeleteArgsSchema,
  RepositorySelectDirectoryArgsSchema,
  RepositoryOpenInExplorerArgsSchema,
} from './validators';
import type { MainLogger } from './logger';

export function registerRepositoryHandlers(
  log: MainLogger,
  repositoryService: RepositoryService
): void {
  handleResult(log, 'repository:list', RepositoryListArgsSchema, (includeProvisioned?) =>
    repositoryService.getAll(includeProvisioned)
  );

  // The args schema normalizes localPath to OS-specific separators
  handleResult(log, 'repository:create', RepositoryCreateArgsSchema, input =>
    repositoryService.create(input)
  );

  handleResult(log, 'repository:update', RepositoryUpdateArgsSchema, input =>
    repositoryService.update(input)
  );

  handleResult(log, 'repository:delete', RepositoryDeleteArgsSchema, id =>
    repositoryService.delete(id)
  );

  handleResult(
    log,
    'repository:select-directory',
    RepositorySelectDirectoryArgsSchema,
    async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Repository Directory',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0] ?? null;
    }
  );

  handleResult(
    log,
    'repository:open-in-explorer',
    RepositoryOpenInExplorerArgsSchema,
    async localPath => {
      await shell.openPath(localPath);
    }
  );
}
