jest.mock('@lore-vcs/sdk', () => ({
  lore: {
    logConfigure: jest.fn(),
  },
}));

jest.mock('electron', () => ({
  app: {
    getPath: (): string => '/tmp/lore-miniplayer-test-userdata',
  },
}));

// resetModules gives each test a fresh module registry, so the SUT's
// module-level init guard starts false. Import lore and the SUT together after
// the reset so both resolve to the same freshly-mocked lore instance.
async function loadFresh(): Promise<{
  initializeLoreSdk: () => void;
  logConfigure: jest.Mock;
}> {
  jest.resetModules();
  const { lore } = await import('@lore-vcs/sdk');
  const { initializeLoreSdk } = await import('../../../src/main/services/lore-sdk');
  return { initializeLoreSdk, logConfigure: lore.logConfigure as jest.Mock };
}

describe('lore-sdk initialization', () => {
  it('should configure SDK file logging under the user data directory', async () => {
    // When: initializing the SDK
    const { initializeLoreSdk, logConfigure } = await loadFresh();
    initializeLoreSdk();

    // Then: file logging is configured under userData
    expect(logConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        file: true,
        filePath: expect.stringContaining('lore-logs'),
      })
    );
  });

  it('should configure logging only once for repeated initialization', async () => {
    // When: initializing twice
    const { initializeLoreSdk, logConfigure } = await loadFresh();
    initializeLoreSdk();
    initializeLoreSdk();

    // Then: the SDK is configured a single time
    expect(logConfigure).toHaveBeenCalledTimes(1);
  });
});
