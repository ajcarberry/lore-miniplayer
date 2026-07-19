jest.mock('@lore-vcs/sdk', () => ({
  lore: {
    logConfigure: jest.fn(),
    shutdown: jest.fn(),
  },
}));

jest.mock('electron', () => ({
  app: {
    getPath: (): string => '/tmp/lore-miniplayer-test-userdata',
  },
}));

import { lore } from '@lore-vcs/sdk';
import { initializeLoreSdk, shutdownLoreSdk } from '../../../src/main/services/lore-sdk';

const mockLore = lore as jest.Mocked<typeof lore>;

describe('lore-sdk lifecycle', () => {
  afterEach(() => {
    // Reset module-level init state between tests
    shutdownLoreSdk();
    jest.clearAllMocks();
  });

  it('should configure SDK logging into the user data directory', () => {
    // When: initializing the SDK
    initializeLoreSdk();

    // Then: file logging is configured under userData
    expect(mockLore.logConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        file: true,
        filePath: expect.stringContaining('lore-logs'),
      })
    );
  });

  it('should only configure once for repeated initialization', () => {
    // When: initializing twice
    initializeLoreSdk();
    initializeLoreSdk();

    // Then: the SDK is configured a single time
    expect(mockLore.logConfigure).toHaveBeenCalledTimes(1);
  });

  it('should shut the SDK down only when initialized', () => {
    // Given: an uninitialized SDK
    shutdownLoreSdk();
    expect(mockLore.shutdown).not.toHaveBeenCalled();

    // When: initializing and shutting down
    initializeLoreSdk();
    shutdownLoreSdk();

    // Then: the native shutdown ran exactly once
    expect(mockLore.shutdown).toHaveBeenCalledTimes(1);
  });

  it('should allow re-initialization after shutdown', () => {
    // Given: a full init/shutdown cycle
    initializeLoreSdk();
    shutdownLoreSdk();

    // When: initializing again
    initializeLoreSdk();

    // Then: logging is configured again
    expect(mockLore.logConfigure).toHaveBeenCalledTimes(2);
  });
});
