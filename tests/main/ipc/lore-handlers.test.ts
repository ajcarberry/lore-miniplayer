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
import { registerLoreHandlers } from '../../../src/main/ipc/lore-handlers';
import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { LoreRepositoryService } from '../../../src/main/services/lore-repository';

const mockLoreRepositoryService = {
  resolveUserName: jest.fn(),
} as unknown as jest.Mocked<LoreRepositoryService>;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(undefined, ...args);
}

beforeAll(() => {
  registerLoreHandlers(log, mockLoreRepositoryService);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('identity:resolveUserName', () => {
  it('registers the channel', () => {
    // Then: identity:resolveUserName is reachable
    expect(registeredHandlers.has(IPC_CHANNELS.identity.resolveUserName)).toBe(true);
  });

  it('resolves a name and wraps it in a success result', async () => {
    // Given: the service resolves a display name for the userId
    mockLoreRepositoryService.resolveUserName.mockResolvedValue('Mara Voss');

    // When: invoking with a valid request
    const result = await invoke(IPC_CHANNELS.identity.resolveUserName, {
      repositoryPath: '/repo',
      userId: 'mara-voss',
    });

    // Then: the service is called with both fields and the name comes back wrapped
    expect(mockLoreRepositoryService.resolveUserName).toHaveBeenCalledWith('/repo', 'mara-voss');
    expect(result).toEqual({ success: true, data: { name: 'Mara Voss' } });
  });

  it('wraps the raw userId fallback the service returns when resolution is unavailable', async () => {
    // Given: the service degrades to the raw userId (no auth endpoint offline)
    mockLoreRepositoryService.resolveUserName.mockResolvedValue('mara-voss');

    // When: invoking
    const result = await invoke(IPC_CHANNELS.identity.resolveUserName, {
      repositoryPath: '/repo',
      userId: 'mara-voss',
    });

    // Then: the fallback name still comes back as a success result
    expect(result).toEqual({ success: true, data: { name: 'mara-voss' } });
  });

  it('rejects a request missing a repositoryPath without touching the service', async () => {
    // When: invoking without a repositoryPath
    const result = (await invoke(IPC_CHANNELS.identity.resolveUserName, {
      repositoryPath: '',
      userId: 'mara-voss',
    })) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockLoreRepositoryService.resolveUserName).not.toHaveBeenCalled();
  });

  it('converts a thrown error into a failure result', async () => {
    // Given: the service throws unexpectedly
    mockLoreRepositoryService.resolveUserName.mockRejectedValue(new Error('boom'));

    // When: invoking
    const result = (await invoke(IPC_CHANNELS.identity.resolveUserName, {
      repositoryPath: '/repo',
      userId: 'mara-voss',
    })) as { success: boolean; error?: string };

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'boom' });
  });
});
