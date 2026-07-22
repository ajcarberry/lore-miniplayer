type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const registeredHandlers = new Map<string, IpcHandler>();

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
    on: jest.fn(),
  },
}));

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: { error: jest.fn(), initialize: jest.fn() },
}));

import log from 'electron-log/main.js';
import { registerWorkspaceHandlers } from '../../../src/main/ipc/workspace-handlers';
import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { WorkspaceService } from '../../../src/main/services/workspace-service';
import type { WorkspaceModelService } from '../../../src/main/services/workspace-model';

const mockWorkspaceService = {
  provision: jest.fn(),
  list: jest.fn(),
  teardown: jest.fn(),
  forget: jest.fn(),
} as unknown as jest.Mocked<WorkspaceService>;

const mockWorkspaceModel = {
  markActive: jest.fn(),
} as unknown as jest.Mocked<WorkspaceModelService>;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(undefined, ...args);
}

const REPO_ID = '3b2f6f2e-4f9b-4a57-9d5c-2f6f2e4f9b4a';

beforeAll(() => {
  registerWorkspaceHandlers(log, mockWorkspaceService, mockWorkspaceModel);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('workspace handler registration', () => {
  it('registers the five workspace channels', () => {
    // Then: provision, list, teardown, markActive, and forget are reachable
    expect(registeredHandlers.has(IPC_CHANNELS.workspace.provision)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.workspace.list)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.workspace.teardown)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.workspace.markActive)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.workspace.forget)).toBe(true);
  });
});

describe('workspace:markActive', () => {
  const MARK_REPO_ID = '3b2f6f2e-4f9b-4a57-9d5c-2f6f2e4f9b4a';

  it('forwards the workspace id to the model and wraps the workspace', async () => {
    // Given: the model returns the updated workspace
    const workspace = {
      instanceId: 'inst-1',
      path: '/repos/myrepo-wt/agent-x',
      branchName: 'agent-x',
      revision: 'r1',
      stale: false,
      repositoryId: MARK_REPO_ID,
      origin: 'provisioned' as const,
    };
    mockWorkspaceModel.markActive.mockResolvedValue(workspace);

    // When: marking active with a valid id
    const result = await invoke(IPC_CHANNELS.workspace.markActive, { workspaceId: 'inst-1' });

    // Then: the model is called and the workspace comes back wrapped
    expect(mockWorkspaceModel.markActive).toHaveBeenCalledWith('inst-1');
    expect(result).toEqual({ success: true, data: workspace });
  });

  it('rejects an empty workspace id without touching the model', async () => {
    // When: marking active with an empty id
    const result = (await invoke(IPC_CHANNELS.workspace.markActive, { workspaceId: '' })) as {
      success: boolean;
    };

    // Then: validation fails before the model is reached
    expect(result.success).toBe(false);
    expect(mockWorkspaceModel.markActive).not.toHaveBeenCalled();
  });

  it('converts model failures into failure results', async () => {
    // Given: the model throws for an unknown workspace
    mockWorkspaceModel.markActive.mockRejectedValue(new Error('Unknown workspace: nope'));

    // When: marking active
    const result = (await invoke(IPC_CHANNELS.workspace.markActive, {
      workspaceId: 'nope',
    })) as { success: boolean; error?: string };

    // Then: the error surfaces as a failure result
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown workspace');
  });
});

describe('workspace:provision', () => {
  it('forwards a valid request and wraps the workspace in a success result', async () => {
    // Given: the service returns a provisioned workspace
    const workspace = {
      instanceId: 'inst-1',
      path: '/repos/myrepo-wt/agent-x',
      branchName: 'agent-x',
      revision: 'r1',
      stale: false,
      repositoryId: REPO_ID,
      origin: 'provisioned' as const,
    };
    mockWorkspaceService.provision.mockResolvedValue(workspace);

    // When: invoking with a valid request
    const result = await invoke(IPC_CHANNELS.workspace.provision, {
      repositoryId: REPO_ID,
      branchName: 'agent-x',
    });

    // Then: the service is called and the workspace comes back wrapped
    expect(mockWorkspaceService.provision).toHaveBeenCalledWith({
      repositoryId: REPO_ID,
      branchName: 'agent-x',
    });
    expect(result).toEqual({ success: true, data: workspace });
  });

  it('rejects a request with a missing branch name without touching the service', async () => {
    // When: invoking without a branch name
    const result = (await invoke(IPC_CHANNELS.workspace.provision, {
      repositoryId: REPO_ID,
      branchName: '',
    })) as { success: boolean; error?: string };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(result.error).toContain('Branch name is required');
    expect(mockWorkspaceService.provision).not.toHaveBeenCalled();
  });

  it('rejects a request whose repository id is not a uuid', async () => {
    // When: invoking with a malformed repository id
    const result = (await invoke(IPC_CHANNELS.workspace.provision, {
      repositoryId: 'not-a-uuid',
      branchName: 'agent-x',
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockWorkspaceService.provision).not.toHaveBeenCalled();
  });

  it('converts service failures into failure results', async () => {
    // Given: the service throws
    mockWorkspaceService.provision.mockRejectedValue(new Error('server unreachable'));

    // When: invoking
    const result = (await invoke(IPC_CHANNELS.workspace.provision, {
      repositoryId: REPO_ID,
      branchName: 'agent-x',
    })) as { success: boolean; error?: string };

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'server unreachable' });
  });
});

describe('workspace:list', () => {
  it('forwards the repository id and wraps the workspace array', async () => {
    // Given: the service returns two workspaces
    const workspaces = [
      {
        instanceId: 'a',
        path: '/w/a',
        branchName: 'x',
        revision: 'r',
        stale: false,
        repositoryId: REPO_ID,
        origin: 'provisioned' as const,
      },
    ];
    mockWorkspaceService.list.mockResolvedValue(workspaces);

    // When: listing
    const result = await invoke(IPC_CHANNELS.workspace.list, { repositoryId: REPO_ID });

    // Then: the service receives the id and the array is wrapped
    expect(mockWorkspaceService.list).toHaveBeenCalledWith(REPO_ID);
    expect(result).toEqual({ success: true, data: workspaces });
  });

  it('rejects a list request with a non-uuid repository id', async () => {
    // When: listing with a bad id
    const result = (await invoke(IPC_CHANNELS.workspace.list, { repositoryId: 42 })) as {
      success: boolean;
    };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockWorkspaceService.list).not.toHaveBeenCalled();
  });
});

describe('workspace:teardown', () => {
  it('forwards an id-based teardown request', async () => {
    // Given: the service returns a teardown result
    const teardownResult = {
      workspaceId: 'inst-1',
      path: '/w/a',
      directoryRemoved: true,
      localBranchRemoved: true,
      remoteBranchRemoved: false,
    };
    mockWorkspaceService.teardown.mockResolvedValue(teardownResult);

    // When: tearing down by id
    const result = await invoke(IPC_CHANNELS.workspace.teardown, {
      workspaceId: 'inst-1',
      force: false,
    });

    // Then: the request is forwarded and the result wrapped
    expect(mockWorkspaceService.teardown).toHaveBeenCalledWith({
      workspaceId: 'inst-1',
      force: false,
    });
    expect(result).toEqual({ success: true, data: teardownResult });
  });

  it('forwards a path-based teardown request', async () => {
    // Given: the service resolves
    mockWorkspaceService.teardown.mockResolvedValue({
      workspaceId: 'inst-1',
      path: '/w/a',
      directoryRemoved: true,
      localBranchRemoved: true,
      remoteBranchRemoved: false,
    });

    // When: tearing down by path
    await invoke(IPC_CHANNELS.workspace.teardown, { path: '/w/a', force: true });

    // Then: the union member is forwarded intact
    expect(mockWorkspaceService.teardown).toHaveBeenCalledWith({ path: '/w/a', force: true });
  });

  it('rejects a teardown request missing the force flag', async () => {
    // When: tearing down without force
    const result = (await invoke(IPC_CHANNELS.workspace.teardown, {
      workspaceId: 'inst-1',
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockWorkspaceService.teardown).not.toHaveBeenCalled();
  });

  it('converts service failures into failure results', async () => {
    // Given: the service refuses a dirty teardown
    mockWorkspaceService.teardown.mockRejectedValue(
      new Error('Workspace has uncommitted changes; pass force to remove it anyway')
    );

    // When: tearing down
    const result = (await invoke(IPC_CHANNELS.workspace.teardown, {
      workspaceId: 'inst-1',
      force: false,
    })) as { success: boolean; error?: string };

    // Then: the error surfaces as a failure result
    expect(result.success).toBe(false);
    expect(result.error).toContain('uncommitted');
  });
});

describe('workspace:forget', () => {
  it('forwards an id-based forget request and wraps a void success result', async () => {
    // Given: the service resolves (untrack-only, no return value)
    mockWorkspaceService.forget.mockResolvedValue(undefined);

    // When: forgetting by id
    const result = await invoke(IPC_CHANNELS.workspace.forget, { workspaceId: 'inst-1' });

    // Then: the request is forwarded and the result wrapped
    expect(mockWorkspaceService.forget).toHaveBeenCalledWith({ workspaceId: 'inst-1' });
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('forwards a path-based forget request', async () => {
    // Given: the service resolves
    mockWorkspaceService.forget.mockResolvedValue(undefined);

    // When: forgetting by path
    await invoke(IPC_CHANNELS.workspace.forget, { path: '/w/a' });

    // Then: the union member is forwarded intact
    expect(mockWorkspaceService.forget).toHaveBeenCalledWith({ path: '/w/a' });
  });

  it('rejects a forget request with neither workspaceId nor path', async () => {
    // When: forgetting with no identifier
    const result = (await invoke(IPC_CHANNELS.workspace.forget, {})) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockWorkspaceService.forget).not.toHaveBeenCalled();
  });

  it('converts service failures into failure results', async () => {
    // Given: the service can't find the workspace
    mockWorkspaceService.forget.mockRejectedValue(
      new Error('Workspace not found or not a tracked instance')
    );

    // When: forgetting
    const result = (await invoke(IPC_CHANNELS.workspace.forget, {
      workspaceId: 'nope',
    })) as { success: boolean; error?: string };

    // Then: the error surfaces as a failure result
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
