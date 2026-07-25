import type { WorkspaceService } from '../services/workspace-service';
import type { WorkspaceModelService } from '../services/workspace-model';
import {
  IPC_CHANNELS,
  WorkspaceProvisionRequestSchema,
  WorkspaceTeardownRequestSchema,
  WorkspaceMarkActiveRequestSchema,
  WorkspaceForgetRequestSchema,
} from '../../shared/schemas';
import { handleRequest } from './result-helpers';
import type { MainLogger } from './logger';

// Workspace lifecycle channels (Mission Control, design 2a): provision a
// worktree, tear one down with full cleanup, manually mark one active (an
// idle → awaiting-review transition owned by the workspace model), and
// forget one (untrack-only, no cleanup — the design amendment's
// non-destructive removal). Each request is re-validated at the boundary
// with its P2 schema.
export function registerWorkspaceHandlers(
  log: MainLogger,
  workspaceService: WorkspaceService,
  workspaceModel: WorkspaceModelService
): void {
  handleRequest(log, IPC_CHANNELS.workspace.provision, WorkspaceProvisionRequestSchema, request =>
    workspaceService.provision(request)
  );

  handleRequest(log, IPC_CHANNELS.workspace.teardown, WorkspaceTeardownRequestSchema, request =>
    workspaceService.teardown(request)
  );

  handleRequest(log, IPC_CHANNELS.workspace.markActive, WorkspaceMarkActiveRequestSchema, request =>
    workspaceModel.markActive(request.workspaceId)
  );

  handleRequest(log, IPC_CHANNELS.workspace.forget, WorkspaceForgetRequestSchema, request =>
    workspaceService.forget(request)
  );
}
