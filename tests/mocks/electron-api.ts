type ElectronAPI = Window['electronAPI'];

// Builds a fully mocked window.electronAPI with benign defaults; individual
// tests override the jest.fn() members they care about
export function createMockElectronAPI(): ElectronAPI {
  return {
    config: {
      get: jest.fn().mockResolvedValue({ success: true, data: { themeMode: 'auto' } }),
      set: jest.fn().mockImplementation(async (update: Record<string, unknown>) => ({
        success: true,
        data: { themeMode: 'auto', ...update },
      })),
    },
    window: {
      minimize: jest.fn(),
      close: jest.fn(),
      move: jest.fn(),
      setNoticeActive: jest.fn(),
      setExpanded: jest.fn().mockResolvedValue({ anchor: 'bottom' }),
      openTerminal: jest.fn().mockResolvedValue({ success: true, data: undefined }),
    },
    repository: {
      list: jest.fn().mockResolvedValue({ success: true, data: [] }),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({ success: true, data: undefined }),
      selectDirectory: jest.fn().mockResolvedValue({ success: true, data: null }),
      openInExplorer: jest.fn().mockResolvedValue({ success: true, data: undefined }),
    },
    lore: {
      branchInfo: jest.fn().mockResolvedValue({
        success: true,
        data: { state: 'unknown', latest: '', latestRemote: '' },
      }),
      branchGraph: jest.fn().mockResolvedValue({
        success: true,
        data: { current: '', branch: { name: '', revisions: [] }, mergesFromParent: [] },
      }),
      currentRevision: jest.fn().mockResolvedValue({ success: true, data: '' }),
      repository: {
        listBranches: jest.fn().mockResolvedValue({ success: true, data: [] }),
        listRemoteRepositories: jest.fn().mockResolvedValue({ success: true, data: [] }),
        checkStatus: jest
          .fn()
          .mockResolvedValue({ success: true, data: { exists: true, isLoreRepo: true } }),
        clone: jest.fn().mockResolvedValue({ success: true, data: undefined }),
        // Returns a cleanup fn like the real bridge; tests capture the
        // registered callback via mock.calls to fire progress events
        onCloneProgress: jest.fn().mockReturnValue(jest.fn()),
        sync: jest.fn().mockResolvedValue({ success: true, data: undefined }),
        commit: jest.fn().mockResolvedValue({ success: true, data: undefined }),
        push: jest.fn().mockResolvedValue({ success: true, data: undefined }),
      },
      files: {
        getStatus: jest.fn().mockResolvedValue({
          success: true,
          data: { untracked: [], unstaged: [], staged: [] },
        }),
        stage: jest.fn().mockResolvedValue({ success: true, data: undefined }),
        unstage: jest.fn().mockResolvedValue({ success: true, data: undefined }),
      },
      notifications: {
        subscribe: jest.fn().mockResolvedValue({ success: true }),
        unsubscribe: jest.fn().mockResolvedValue({ success: true }),
        // Returns a cleanup fn like the real bridge; tests capture the
        // registered callback via mock.calls to fire notifications
        onNotification: jest.fn().mockReturnValue(jest.fn()),
      },
    },
    missionControl: {
      open: jest.fn(),
      close: jest.fn(),
      watch: jest.fn().mockResolvedValue({ success: true, data: { repositoryId: '', cards: [] } }),
      // Returns a cleanup fn like the real bridge; tests capture the
      // registered callback via mock.calls to fire snapshot pushes.
      onSnapshot: jest.fn().mockReturnValue(jest.fn()),
    },
    path: {
      join: jest.fn(async (segments: string[]) => ({
        success: true as const,
        data: segments.join('/'),
      })),
      basename: jest.fn(async (p: string) => ({
        success: true as const,
        data: p.split('/').pop() ?? p,
      })),
    },
  } as unknown as ElectronAPI;
}

// Installs the mock on window and returns it for per-test overrides
export function installMockElectronAPI(): ElectronAPI {
  const api = createMockElectronAPI();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: api,
  });
  return api;
}
