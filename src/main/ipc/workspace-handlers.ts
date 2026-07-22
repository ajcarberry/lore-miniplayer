import type { WorkspaceService } from '../services/workspace-service';
import type { WorkspaceModelService } from '../services/workspace-model';
import { IPC_CHANNELS } from '../../shared/schemas';
import { handleResult } from './result-helpers';
import {
  WorkspaceProvisionArgsSchema,
  WorkspaceListArgsSchema,
  WorkspaceTeardownArgsSchema,
  WorkspaceMarkActiveArgsSchema,
  WorkspaceForgetArgsSchema,
} from './validators';
import type { MainLogger } from './logger';

// Workspace lifecycle channels (Mission Control, design 2a): provision a
// worktree, list a repository's workspaces, tear one down with full cleanup,
// manually mark one active (an idle → awaiting-review transition owned by
// the workspace model), and forget one (untrack-only, no cleanup — the
// design amendment's non-destructive removal). Each request is re-validated
// at the boundary with its P2 schema.
export function registerWorkspaceHandlers(
  log: MainLogger,
  workspaceService: WorkspaceService,
  workspaceModel: WorkspaceModelService
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

  handleResult(log, IPC_CHANNELS.workspace.markActive, WorkspaceMarkActiveArgsSchema, request =>
    workspaceModel.markActive(request.workspaceId)
  );

  handleResult(log, IPC_CHANNELS.workspace.forget, WorkspaceForgetArgsSchema, request =>
    workspaceService.forget(request)
  );
}
