import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const registeredHandlers = new Map<string, IpcHandler>();
const registeredListeners = new Map<string, IpcHandler>();
// config-handlers resolves its store path from Electron's userData directory;
// point it at a per-suite temp dir so config:get/config:set run against the
// real filesystem
const mockUserData = { dir: '' };

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
    on: jest.fn((channel: string, listener: IpcHandler) => {
      registeredListeners.set(channel, listener);
    }),
  },
  BrowserWindow: { fromWebContents: jest.fn() },
  dialog: { showOpenDialog: jest.fn() },
  shell: { openPath: jest.fn() },
  app: {
    getPath: (): string => mockUserData.dir,
  },
}));

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: { error: jest.fn(), initialize: jest.fn() },
}));

import { BrowserWindow, dialog } from 'electron';
import log from 'electron-log/main.js';
import { registerIpcHandlers } from '../../../src/main/ipc/handlers';
import type { RepositoryService } from '../../../src/main/services/repository';
import type { LoreRepositoryService } from '../../../src/main/services/lore-repository';

const mockRepositoryService = {
  getAll: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
} as unknown as jest.Mocked<RepositoryService>;

const mockLoreRepositoryService = {
  listBranches: jest.fn(),
  listRemoteRepositories: jest.fn(),
  checkRepositoryStatus: jest.fn(),
  cloneRepository: jest.fn(),
  syncRepository: jest.fn(),
  getFileStatus: jest.fn(),
  stageFiles: jest.fn(),
  unstageFiles: jest.fn(),
  commit: jest.fn(),
  push: jest.fn(),
  getBranchDivergence: jest.fn(),
  getBranchGraph: jest.fn(),
  subscribeNotifications: jest.fn(),
  unsubscribeNotifications: jest.fn(),
  getCurrentRevision: jest.fn(),
} as unknown as jest.Mocked<LoreRepositoryService>;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(undefined, ...args);
}

beforeAll(() => {
  mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-miniplayer-handlers-test-'));
  registerIpcHandlers(log, mockRepositoryService, mockLoreRepositoryService);
});

afterAll(() => {
  fs.rmSync(mockUserData.dir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('IPC handler registration', () => {
  it('should register no auth channels', () => {
    // Then: nothing under lore:auth remains registered
    const authChannels = [...registeredHandlers.keys()].filter(c => c.startsWith('lore:auth'));
    expect(authChannels).toEqual([]);
  });

  it('should register the expected lore channels', () => {
    // Then: all repository/file operations are reachable
    const expected = [
      'lore:repository:list-remote',
      'lore:branches:list',
      'lore:repository:status',
      'lore:repository:clone',
      'lore:repository:sync',
      'lore:repository:commit',
      'lore:repository:push',
      'lore:files:status',
      'lore:files:stage',
      'lore:files:unstage',
      'lore:branchInfo',
      'lore:notifications:subscribe',
      'lore:notifications:unsubscribe',
      'lore:currentRevision',
    ];
    for (const channel of expected) {
      expect(registeredHandlers.has(channel)).toBe(true);
    }
  });
});

describe('lore:currentRevision handler', () => {
  it('returns the current revision for a valid path', async () => {
    // Given: the service resolves a hash
    mockLoreRepositoryService.getCurrentRevision.mockResolvedValue('workspace-hash');

    // When: invoking with a valid path
    const result = await invoke('lore:currentRevision', '/repos/a');

    // Then: the hash comes back as a success result
    expect(mockLoreRepositoryService.getCurrentRevision).toHaveBeenCalledWith('/repos/a');
    expect(result).toEqual({ success: true, data: 'workspace-hash' });
  });

  it('rejects a non-string path without touching the service', async () => {
    // When: invoking with a bad payload
    const result = (await invoke('lore:currentRevision', 42)) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockLoreRepositoryService.getCurrentRevision).not.toHaveBeenCalled();
  });

  it('returns a failure result when the service throws', async () => {
    // Given: the service rejects
    mockLoreRepositoryService.getCurrentRevision.mockRejectedValue(new Error('db locked'));

    // When: invoking
    const result = (await invoke('lore:currentRevision', '/repos/a')) as { success: boolean };

    // Then: the error surfaces as a failure result
    expect(result.success).toBe(false);
  });
});

describe('lore notification handlers', () => {
  it('subscribes the given repository path', async () => {
    // Given: the service resolves
    mockLoreRepositoryService.subscribeNotifications.mockResolvedValue(undefined);

    // When: invoking subscribe with a valid path
    const result = await invoke('lore:notifications:subscribe', '/repos/a');

    // Then: the service is called and the result is a success
    expect(mockLoreRepositoryService.subscribeNotifications).toHaveBeenCalledWith('/repos/a');
    expect(result).toEqual({ success: true });
  });

  it('rejects a non-string repository path without touching the service', async () => {
    // When: invoking subscribe with a bad payload
    const result = (await invoke('lore:notifications:subscribe', 42)) as { success: boolean };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockLoreRepositoryService.subscribeNotifications).not.toHaveBeenCalled();
  });

  it('returns a failure result when the service subscribe throws', async () => {
    // Given: the service rejects
    mockLoreRepositoryService.subscribeNotifications.mockRejectedValue(new Error('no server'));

    // When: invoking subscribe
    const result = (await invoke('lore:notifications:subscribe', '/repos/a')) as {
      success: boolean;
      error?: string;
    };

    // Then: the error surfaces as a failure result
    expect(result.success).toBe(false);
    expect(result.error).toContain('no server');
  });

  it('unsubscribes the given repository path', async () => {
    // Given: the service resolves
    mockLoreRepositoryService.unsubscribeNotifications.mockResolvedValue(undefined);

    // When: invoking unsubscribe with a valid path
    const result = await invoke('lore:notifications:unsubscribe', '/repos/a');

    // Then: the service is called and the result is a success
    expect(mockLoreRepositoryService.unsubscribeNotifications).toHaveBeenCalledWith('/repos/a');
    expect(result).toEqual({ success: true });
  });

  it('returns a failure result when the service unsubscribe throws', async () => {
    // Given: the service rejects
    mockLoreRepositoryService.unsubscribeNotifications.mockRejectedValue(new Error('gone'));

    // When: invoking unsubscribe
    const result = (await invoke('lore:notifications:unsubscribe', '/repos/a')) as {
      success: boolean;
    };

    // Then: the error surfaces as a failure result
    expect(result.success).toBe(false);
  });
});

describe('config handlers', () => {
  it('should return the default configuration', async () => {
    // When: requesting the config
    const result = await invoke('config:get');

    // Then: validated defaults are returned in a success result
    expect(result).toEqual({ success: true, data: { themeMode: 'auto' } });
  });
});

describe('repository handlers', () => {
  it('should list repositories from the service', async () => {
    // Given: the service returns repositories
    const repos = [{ id: '1', name: 'A' }];
    mockRepositoryService.getAll.mockResolvedValue(repos as never);

    // When: listing
    const result = await invoke('repository:list');

    // Then: the service data is passed through in a success result
    expect(result).toEqual({ success: true, data: repos });
  });

  it('should normalize the local path when creating', async () => {
    // Given: the service echoes its input
    mockRepositoryService.create.mockImplementation(async input => input as never);

    // When: creating with a denormalized path
    await invoke('repository:create', {
      name: 'A',
      url: 'lore.example.com/A',
      localPath: '/tmp//repos/../repos/a',
    });

    // Then: the path reaching the service is normalized (platform separators)
    expect(mockRepositoryService.create).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: path.normalize('/tmp/repos/a') })
    );
  });

  it('should reject deleting with a non-string id', async () => {
    // When: deleting with a numeric id
    const result = await invoke('repository:delete', 42);

    // Then: a failure result is returned and never reaches the service
    expect(result).toEqual({ success: false, error: 'Invalid repository ID' });
    expect(mockRepositoryService.delete).not.toHaveBeenCalled();
  });

  it('should return null when the directory dialog is cancelled', async () => {
    // Given: the user cancels the dialog
    (dialog.showOpenDialog as jest.Mock).mockResolvedValue({ canceled: true, filePaths: [] });

    // When: selecting a directory
    const result = await invoke('repository:select-directory');

    // Then: a null success result is returned
    expect(result).toEqual({ success: true, data: null });
  });
});

describe('lore repository handlers', () => {
  it('should reject list-remote without a server address', async () => {
    // When: listing with an empty address
    const result = await invoke('lore:repository:list-remote', '   ');

    // Then: a failure result is returned and the service is not called
    expect(result).toEqual({ success: false, error: 'Invalid server address' });
    expect(mockLoreRepositoryService.listRemoteRepositories).not.toHaveBeenCalled();
  });

  it('should trim and forward the server address to the service', async () => {
    // Given: the service returns repositories
    mockLoreRepositoryService.listRemoteRepositories.mockResolvedValue([
      { name: 'RepoA', url: 'lore.example.com/RepoA' },
    ]);

    // When: listing with padded input
    const result = await invoke('lore:repository:list-remote', '  lore.example.com  ');

    // Then: the trimmed address is used and data returned in a Result
    expect(mockLoreRepositoryService.listRemoteRepositories).toHaveBeenCalledWith(
      'lore.example.com'
    );
    expect(result).toEqual({
      success: true,
      data: [{ name: 'RepoA', url: 'lore.example.com/RepoA' }],
    });
  });

  it('should convert service failures into failure results', async () => {
    // Given: the service throws
    mockLoreRepositoryService.listBranches.mockRejectedValue(new Error('boom'));

    // When: listing branches
    const result = await invoke('lore:branches:list', '/repo');

    // Then: a failure result carries the message
    expect(result).toEqual({ success: false, error: 'boom' });
  });

  it('should reject branch listing with a non-string path', async () => {
    // When: listing with an invalid path
    const result = await invoke('lore:branches:list', 123);

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid repository path' });
    expect(mockLoreRepositoryService.listBranches).not.toHaveBeenCalled();
  });

  it('should forward only recognized sync options', async () => {
    // Given: a successful sync
    mockLoreRepositoryService.syncRepository.mockResolvedValue(undefined);

    // When: syncing with extra unknown options mixed in
    const result = await invoke('lore:repository:sync', '/repo', undefined, {
      revision: 'abc123',
      reset: true,
      bogus: 'ignored',
    });

    // Then: only the valid options reach the service
    expect(mockLoreRepositoryService.syncRepository).toHaveBeenCalledWith('/repo', undefined, {
      revision: 'abc123',
      reset: true,
    });
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('should reject staging with non-string paths', async () => {
    // When: staging with a mixed array
    const result = await invoke('lore:files:stage', '/repo', ['ok.txt', 7]);

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid file paths' });
    expect(mockLoreRepositoryService.stageFiles).not.toHaveBeenCalled();
  });

  it('should reject an empty commit message', async () => {
    // When: committing whitespace
    const result = await invoke('lore:repository:commit', '/repo', '   ');

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid commit message' });
    expect(mockLoreRepositoryService.commit).not.toHaveBeenCalled();
  });

  it('should reject an invalid repository path for push', async () => {
    // When: pushing with a non-string path
    const result = await invoke('lore:repository:push', 42);

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid repository path' });
    expect(mockLoreRepositoryService.push).not.toHaveBeenCalled();
  });
});

describe('lore repository happy paths', () => {
  it('should check repository status', async () => {
    // Given: the service reports a repository
    mockLoreRepositoryService.checkRepositoryStatus.mockResolvedValue({
      exists: true,
      isLoreRepo: true,
    });

    // When: checking status
    const result = await invoke('lore:repository:status', '/repo');

    // Then: the status is wrapped in a success result
    expect(result).toEqual({ success: true, data: { exists: true, isLoreRepo: true } });
  });

  it('should normalize the target path when cloning', async () => {
    // Given: a successful clone
    mockLoreRepositoryService.cloneRepository.mockResolvedValue(undefined);

    // When: cloning to a denormalized path
    const result = await invoke(
      'lore:repository:clone',
      'lore.example.com/Repo',
      '/tmp//repos/../repos/checkout'
    );

    // Then: the normalized path reaches the service (platform separators)
    expect(mockLoreRepositoryService.cloneRepository).toHaveBeenCalledWith(
      'lore.example.com/Repo',
      path.normalize('/tmp/repos/checkout')
    );
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('should return file status groups', async () => {
    // Given: the service reports grouped files
    const groups = { untracked: [], unstaged: [], staged: [] };
    mockLoreRepositoryService.getFileStatus.mockResolvedValue(groups);

    // When: requesting file status
    const result = await invoke('lore:files:status', '/repo');

    // Then: the groups are wrapped in a success result
    expect(result).toEqual({ success: true, data: groups });
  });

  it('should unstage files through the service', async () => {
    // Given: a successful unstage
    mockLoreRepositoryService.unstageFiles.mockResolvedValue(undefined);

    // When: unstaging with a repo-relative path
    const result = await invoke('lore:files:unstage', '/repo', ['a.txt']);

    // Then: the service receives the path joined against the repository
    expect(mockLoreRepositoryService.unstageFiles).toHaveBeenCalledWith('/repo', [
      path.join('/repo', 'a.txt'),
    ]);
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('should commit through the service without pushing', async () => {
    // Given: a successful commit
    mockLoreRepositoryService.commit.mockResolvedValue(undefined);

    // When: committing
    const result = await invoke('lore:repository:commit', '/repo', 'A message');

    // Then: the service is called and a void success returned
    expect(mockLoreRepositoryService.commit).toHaveBeenCalledWith('/repo', 'A message');
    expect(mockLoreRepositoryService.push).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('should push through the service without committing', async () => {
    // Given: a successful push
    mockLoreRepositoryService.push.mockResolvedValue(undefined);

    // When: pushing
    const result = await invoke('lore:repository:push', '/repo');

    // Then: the service is called and a void success returned
    expect(mockLoreRepositoryService.push).toHaveBeenCalledWith('/repo');
    expect(mockLoreRepositoryService.commit).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('should convert clone failures into failure results', async () => {
    // Given: the clone throws
    mockLoreRepositoryService.cloneRepository.mockRejectedValue(new Error('server unreachable'));

    // When: cloning
    const result = await invoke('lore:repository:clone', 'lore.example.com/Repo', '/tmp/checkout');

    // Then: the failure carries the message
    expect(result).toEqual({ success: false, error: 'server unreachable' });
  });

  it('should reject sync with a non-string repository path', async () => {
    // When: syncing with an invalid path
    const result = await invoke('lore:repository:sync', 99);

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid repository path' });
    expect(mockLoreRepositoryService.syncRepository).not.toHaveBeenCalled();
  });
});

describe('lore:branchInfo handler', () => {
  it('should return branch divergence on success', async () => {
    // Given: the service resolves a divergence result
    mockLoreRepositoryService.getBranchDivergence.mockResolvedValue({
      state: 'inSync',
      latest: 'abc123',
      latestRemote: 'abc123',
    });

    // When: requesting branch info
    const result = await invoke('lore:branchInfo', { repositoryPath: '/repo', branch: 'main' });

    // Then: the divergence is wrapped in a success result
    expect(mockLoreRepositoryService.getBranchDivergence).toHaveBeenCalledWith('/repo', 'main');
    expect(result).toEqual({
      success: true,
      data: { state: 'inSync', latest: 'abc123', latestRemote: 'abc123' },
    });
  });

  it('should reject a request missing the branch field', async () => {
    // When: requesting with no branch
    const result = await invoke('lore:branchInfo', { repositoryPath: '/repo' });

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid repository path or branch' });
    expect(mockLoreRepositoryService.getBranchDivergence).not.toHaveBeenCalled();
  });

  it('should reject a request with a non-string repository path', async () => {
    // When: requesting with an invalid repositoryPath type
    const result = await invoke('lore:branchInfo', { repositoryPath: 42, branch: 'main' });

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid repository path or branch' });
    expect(mockLoreRepositoryService.getBranchDivergence).not.toHaveBeenCalled();
  });

  it('should convert service failures into failure results', async () => {
    // Given: the service throws
    mockLoreRepositoryService.getBranchDivergence.mockRejectedValue(new Error('no such branch'));

    // When: requesting branch info
    const result = await invoke('lore:branchInfo', { repositoryPath: '/repo', branch: 'main' });

    // Then: a failure result carries the message
    expect(result).toEqual({ success: false, error: 'no such branch' });
  });
});

describe('lore:branchGraph handler', () => {
  const sampleGraph = {
    current: 'tip-hash',
    branch: {
      name: 'main',
      revisions: [
        { revision: 'newer-hash', revisionNumber: 42 },
        { revision: 'older-hash', revisionNumber: 41 },
      ],
    },
    mergesFromParent: [],
    mergesToParent: [],
  };

  it('should return the branch graph on success', async () => {
    // Given: the service resolves a branch graph
    mockLoreRepositoryService.getBranchGraph.mockResolvedValue(sampleGraph);

    // When: requesting the branch graph
    const result = await invoke('lore:branchGraph', { repositoryPath: '/repo', branch: 'main' });

    // Then: the graph is wrapped in a success result
    expect(mockLoreRepositoryService.getBranchGraph).toHaveBeenCalledWith('/repo', 'main');
    expect(result).toEqual({ success: true, data: sampleGraph });
  });

  it('should reject a request missing the branch field', async () => {
    // When: requesting with no branch
    const result = await invoke('lore:branchGraph', { repositoryPath: '/repo' });

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid repository path or branch' });
    expect(mockLoreRepositoryService.getBranchGraph).not.toHaveBeenCalled();
  });

  it('should reject a request missing the repository path', async () => {
    // When: requesting with no repository path
    const result = await invoke('lore:branchGraph', { branch: 'main' });

    // Then: a failure result is returned without calling the service
    expect(result).toEqual({ success: false, error: 'Invalid repository path or branch' });
    expect(mockLoreRepositoryService.getBranchGraph).not.toHaveBeenCalled();
  });

  it('should convert service failures into failure results', async () => {
    // Given: the service throws
    mockLoreRepositoryService.getBranchGraph.mockRejectedValue(new Error('no such branch'));

    // When: requesting the branch graph
    const result = await invoke('lore:branchGraph', { repositoryPath: '/repo', branch: 'main' });

    // Then: a failure result carries the message
    expect(result).toEqual({ success: false, error: 'no such branch' });
  });
});

describe('repository handler error wrapping', () => {
  it('should convert service failures into failure results when updating', async () => {
    // Given: the update throws
    mockRepositoryService.update.mockRejectedValue(new Error('nope'));

    // When: updating with a schema-valid input
    const result = await invoke('repository:update', {
      id: '3b2f6f2e-4f9b-4a57-9d5c-2f6f2e4f9b4a',
      name: 'y',
    });

    // Then: the error surfaces as a failure result
    expect(result).toEqual({ success: false, error: 'nope' });
  });

  it('should reject an update whose id is not a UUID without touching the service', async () => {
    // When: updating with a malformed id
    const result = (await invoke('repository:update', { id: 'x', name: 'y' })) as {
      success: boolean;
    };

    // Then: validation fails before the service is reached
    expect(result.success).toBe(false);
    expect(mockRepositoryService.update).not.toHaveBeenCalled();
  });

  it('should return the selected directory from the dialog', async () => {
    // Given: the user picks a directory
    (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
      canceled: false,
      filePaths: ['/picked/dir'],
    });

    // When: selecting
    const result = await invoke('repository:select-directory');

    // Then: the chosen path is returned in a success result
    expect(result).toEqual({ success: true, data: '/picked/dir' });
  });
});

describe('window listeners', () => {
  it('should round fractional move coordinates instead of rejecting them', () => {
    // Given: a window resolved from the sender and Retina-fractional
    // coordinates (rejecting these made the pill immovable)
    const setPosition = jest.fn();
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue({ setPosition });
    const listener = registeredListeners.get('window:move');

    // When: a move arrives with fractional coordinates
    listener?.({ sender: {} }, 1000.7421875, 169.9140625);

    // Then: the window is moved to the nearest integer position
    expect(setPosition).toHaveBeenCalledWith(1001, 170);
  });

  it('should ignore a move with non-numeric coordinates', () => {
    // Given: a window resolved from the sender
    const setPosition = jest.fn();
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue({ setPosition });
    const listener = registeredListeners.get('window:move');

    // When: a malformed move arrives
    listener?.({ sender: {} }, 'NaN', Infinity);

    // Then: it is dropped
    expect(setPosition).not.toHaveBeenCalled();
  });

  it('should minimize the window that sent the event', () => {
    // Given: a window resolved from the sender
    const minimize = jest.fn();
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue({ minimize });
    const listener = registeredListeners.get('window:minimize');

    // When: the minimize message arrives
    listener?.({ sender: {} });

    // Then: the window is minimized
    expect(minimize).toHaveBeenCalled();
  });
});
