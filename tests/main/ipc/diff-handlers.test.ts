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
import { registerDiffHandlers } from '../../../src/main/ipc/diff-handlers';
import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { DiffService } from '../../../src/main/services/diff-service';

const mockDiffService = {
  compare: jest.fn(),
  workspaceDirtyStats: jest.fn(),
} as unknown as jest.Mocked<DiffService>;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(undefined, ...args);
}

beforeAll(() => {
  registerDiffHandlers(log, mockDiffService);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('diff handler registration', () => {
  it('registers the compare channel', () => {
    // Then: diff:compare is reachable
    expect(registeredHandlers.has(IPC_CHANNELS.diff.compare)).toBe(true);
  });
});

describe('diff:compare', () => {
  const request = {
    repositoryPath: '/repo',
    source: { kind: 'revision' as const, revision: 'r1' },
    target: { kind: 'workingTree' as const },
  };

  it('forwards a valid request and wraps the response in a success result', async () => {
    // Given: the service returns a diff result
    const diff = [
      { path: 'a.txt', action: 'modified' as const, patch: '@@', binary: false, truncated: false },
    ];
    mockDiffService.compare.mockResolvedValue(diff);

    // When: invoking with a valid request
    const result = await invoke(IPC_CHANNELS.diff.compare, request);

    // Then: the service is called and the diff comes back wrapped
    expect(mockDiffService.compare).toHaveBeenCalledWith(request);
    expect(result).toEqual({ success: true, data: diff });
  });

  it('rejects a request missing a repositoryPath without touching the service', async () => {
    // When: invoking without a repositoryPath
    const result = (await invoke(IPC_CHANNELS.diff.compare, {
      ...request,
      repositoryPath: '',
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockDiffService.compare).not.toHaveBeenCalled();
  });

  it('rejects a request with a malformed CompareTarget', async () => {
    // When: invoking with an unknown target kind
    const result = (await invoke(IPC_CHANNELS.diff.compare, {
      ...request,
      target: { kind: 'bogus' },
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockDiffService.compare).not.toHaveBeenCalled();
  });

  it('converts service failures into failure results', async () => {
    // Given: the service throws
    mockDiffService.compare.mockRejectedValue(new Error('No such revision'));

    // When: invoking
    const result = (await invoke(IPC_CHANNELS.diff.compare, request)) as {
      success: boolean;
      error?: string;
    };

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'No such revision' });
  });
});
