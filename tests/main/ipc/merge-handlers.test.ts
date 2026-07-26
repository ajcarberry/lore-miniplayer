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
import { registerMergeHandlers } from '../../../src/main/ipc/merge-handlers';
import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { MergeService } from '../../../src/main/services/merge-service';
import type { MergeState } from '../../../src/shared/types';

const mockMergeService = {
  start: jest.fn(),
  resolve: jest.fn(),
  abort: jest.fn(),
  complete: jest.fn(),
} as unknown as jest.Mocked<MergeService>;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(undefined, ...args);
}

const mergeState: MergeState = {
  sourceBranch: 'agent-x',
  targetBranch: 'main',
  targetRevision: 'main-remote-tip',
  files: [{ path: 'conf.txt', state: 'conflict' }],
  allResolved: false,
  hasChangesToLand: true,
};

beforeAll(() => {
  registerMergeHandlers(log, mockMergeService);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('merge handler registration', () => {
  it('registers the start/resolve/abort/complete channels', () => {
    expect(registeredHandlers.has(IPC_CHANNELS.merge.start)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.merge.resolve)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.merge.abort)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.merge.complete)).toBe(true);
  });
});

describe('merge:start', () => {
  const request = { repositoryPath: '/wt/agent-x', sourceBranch: 'agent-x', targetBranch: 'main' };

  it('forwards a valid request and wraps the merge state in a success result', async () => {
    // Given: the service returns a merge state
    mockMergeService.start.mockResolvedValue(mergeState);

    // When: invoking with a valid request
    const result = await invoke(IPC_CHANNELS.merge.start, request);

    // Then: the service is called and the state comes back wrapped
    expect(mockMergeService.start).toHaveBeenCalledWith(request);
    expect(result).toEqual({ success: true, data: mergeState });
  });

  it('rejects a request missing the source branch without touching the service', async () => {
    // When: invoking with an empty sourceBranch
    const result = (await invoke(IPC_CHANNELS.merge.start, {
      ...request,
      sourceBranch: '',
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockMergeService.start).not.toHaveBeenCalled();
  });

  it('converts service failures into failure results', async () => {
    // Given: the service throws (e.g. a merge already in flight)
    mockMergeService.start.mockRejectedValue(new Error('A merge is already in progress'));

    // When: invoking
    const result = (await invoke(IPC_CHANNELS.merge.start, request)) as {
      success: boolean;
      error?: string;
    };

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'A merge is already in progress' });
  });
});

describe('merge:resolve', () => {
  const request = { repositoryPath: '/wt/agent-x', path: 'conf.txt', resolution: 'mine' as const };

  it('forwards a valid resolve request', async () => {
    // Given: the service returns an updated state
    mockMergeService.resolve.mockResolvedValue({ ...mergeState, allResolved: true });

    // When: invoking with a valid request
    const result = await invoke(IPC_CHANNELS.merge.resolve, request);

    // Then: the service is called and the state is wrapped
    expect(mockMergeService.resolve).toHaveBeenCalledWith(request);
    expect(result).toEqual({ success: true, data: { ...mergeState, allResolved: true } });
  });

  it('rejects an unknown resolution value without touching the service', async () => {
    // When: invoking with an invalid resolution
    const result = (await invoke(IPC_CHANNELS.merge.resolve, {
      ...request,
      resolution: 'both',
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockMergeService.resolve).not.toHaveBeenCalled();
  });
});

describe('merge:abort', () => {
  const request = { repositoryPath: '/wt/agent-x' };

  it('forwards a valid abort request', async () => {
    // Given: the service confirms the abort
    mockMergeService.abort.mockResolvedValue({ aborted: true });

    // When: invoking
    const result = await invoke(IPC_CHANNELS.merge.abort, request);

    // Then: the service is called and the confirmation wrapped
    expect(mockMergeService.abort).toHaveBeenCalledWith(request);
    expect(result).toEqual({ success: true, data: { aborted: true } });
  });

  it('rejects a request missing the repository path', async () => {
    // When: invoking with an empty repositoryPath
    const result = (await invoke(IPC_CHANNELS.merge.abort, { repositoryPath: '' })) as {
      success: boolean;
    };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockMergeService.abort).not.toHaveBeenCalled();
  });
});

describe('merge:complete', () => {
  const request = { repositoryPath: '/wt/agent-x' };

  it('forwards a valid complete request and returns the revision', async () => {
    // Given: the service lands the merge
    mockMergeService.complete.mockResolvedValue({ revision: 'merge-rev' });

    // When: invoking
    const result = await invoke(IPC_CHANNELS.merge.complete, request);

    // Then: the service is called and the revision wrapped
    expect(mockMergeService.complete).toHaveBeenCalledWith(request);
    expect(result).toEqual({ success: true, data: { revision: 'merge-rev' } });
  });

  it('converts service failures into failure results', async () => {
    // Given: the service refuses (unresolved conflicts)
    mockMergeService.complete.mockRejectedValue(new Error('conflicts remain unresolved'));

    // When: invoking
    const result = (await invoke(IPC_CHANNELS.merge.complete, request)) as {
      success: boolean;
      error?: string;
    };

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'conflicts remain unresolved' });
  });
});
