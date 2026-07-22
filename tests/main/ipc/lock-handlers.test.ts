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
import { registerLockHandlers } from '../../../src/main/ipc/lock-handlers';
import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { LockService } from '../../../src/main/services/lock-service';

const mockLockService = {
  query: jest.fn(),
  release: jest.fn(),
} as unknown as jest.Mocked<LockService>;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(undefined, ...args);
}

beforeAll(() => {
  registerLockHandlers(log, mockLockService);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('lock handler registration', () => {
  it('registers the query and release channels', () => {
    // Then: both locks:* channels are reachable
    expect(registeredHandlers.has(IPC_CHANNELS.locks.query)).toBe(true);
    expect(registeredHandlers.has(IPC_CHANNELS.locks.release)).toBe(true);
  });
});

describe('locks:query', () => {
  it('forwards a valid request and wraps the response in a success result', async () => {
    // Given: the service returns lock entries
    const entries = [{ path: 'a.txt', userId: 'user-1', branch: 'main' }];
    mockLockService.query.mockResolvedValue(entries);

    // When: invoking with a valid request
    const request = { repositoryPath: '/repo' };
    const result = await invoke(IPC_CHANNELS.locks.query, request);

    // Then: the service is called and the entries come back wrapped
    expect(mockLockService.query).toHaveBeenCalledWith(request);
    expect(result).toEqual({ success: true, data: entries });
  });

  it('rejects a request missing a repositoryPath without touching the service', async () => {
    // When: invoking without a repositoryPath
    const result = (await invoke(IPC_CHANNELS.locks.query, { repositoryPath: '' })) as {
      success: boolean;
    };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockLockService.query).not.toHaveBeenCalled();
  });

  it('converts service failures into failure results', async () => {
    // Given: the service throws
    mockLockService.query.mockRejectedValue(new Error('Failed to query locks'));

    // When: invoking
    const result = (await invoke(IPC_CHANNELS.locks.query, { repositoryPath: '/repo' })) as {
      success: boolean;
      error?: string;
    };

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'Failed to query locks' });
  });
});

describe('locks:release', () => {
  it('forwards a valid request and wraps the response in a success result', async () => {
    // Given: the service releases a lock
    mockLockService.release.mockResolvedValue({ released: ['a.txt'] });

    // When: invoking with a valid request
    const request = { repositoryPath: '/repo', paths: ['a.txt'] };
    const result = await invoke(IPC_CHANNELS.locks.release, request);

    // Then: the service is called and the result comes back wrapped
    expect(mockLockService.release).toHaveBeenCalledWith(request);
    expect(result).toEqual({ success: true, data: { released: ['a.txt'] } });
  });

  it('rejects a request with no paths without touching the service', async () => {
    // When: invoking with an empty paths array
    const result = (await invoke(IPC_CHANNELS.locks.release, {
      repositoryPath: '/repo',
      paths: [],
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockLockService.release).not.toHaveBeenCalled();
  });

  it('converts service failures into failure results', async () => {
    // Given: the service throws
    mockLockService.release.mockRejectedValue(new Error('Failed to release locks'));

    // When: invoking
    const result = (await invoke(IPC_CHANNELS.locks.release, {
      repositoryPath: '/repo',
      paths: ['a.txt'],
    })) as { success: boolean; error?: string };

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'Failed to release locks' });
  });
});
