import type { WorkspaceService } from '../services/workspace-service';
import { IPC_CHANNELS } from '../../shared/schemas';
import { handleResult } from './result-helpers';
import {
  WorkspaceProvisionArgsSchema,
  WorkspaceListArgsSchema,
  WorkspaceTeardownArgsSchema,
} from './validators';
import type { MainLogger } from './logger';

// Workspace lifecycle channels (Mission Control, design 2a): provision a
// worktree, list a repository's workspaces, and tear one down with full
// cleanup. Each request is re-validated at the boundary with its P2 schema.
export function registerWorkspaceHandlers(
  log: MainLogger,
  workspaceService: WorkspaceService
): void {
  handleResult(log, IPC_CHANNELS.workspace.provision, WorkspaceProvisionArgsSchema, request =>
    workspaceService.provision(request)
  );

  handleResult(log, IPC_CHANNELS.workspace.list, WorkspaceListArgsSchema, request =>
    workspaceService.list(request.repositoryId)
  );

  handleResult(log, IPC_CHANNELS.workspace.teardown, WorkspaceTeardownArgsSchema, request =>
    workspaceService.teardown(request)
  );
}
