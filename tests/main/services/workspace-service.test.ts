// Mock the Lore SDK completely so tests never load the native FFI layer. The
// enums subpath is NOT mocked — it is pure data and keeps event-tag
// assertions accurate. The repository store and lore-repository service are
// injected as plain mocks, so neither is loaded here either.
jest.mock('@lore-vcs/sdk', () => {
  class LoreError extends Error {
    loreErrors: Array<{ tag: number; data: { errorType: number; errorInner: string } }> | undefined;

    constructor(
      loreErrors?: Array<{ tag: number; data: { errorType: number; errorInner: string } }>
    ) {
      const messages = loreErrors?.map(e => e.data.errorInner).filter(Boolean) ?? [];
      super(messages.length ? messages.join('\n') : 'Error when calling Lore');
      this.loreErrors = loreErrors;
    }
  }

  return {
    LoreError,
    lore: {
      repositoryClone: jest.fn(),
      branchCreate: jest.fn(),
      branchArchive: jest.fn(),
      repositoryInstanceList: jest.fn(),
      repositoryInstancePrune: jest.fn(),
    },
  };
});

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { lore, LoreError } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import {
  WorkspaceService,
  WorkspaceOperationError,
} from '../../../src/main/services/workspace-service';
import type { RepositoryService } from '../../../src/main/services/repository';
import type { LoreRepositoryService } from '../../../src/main/services/lore-repository';
import type { Repository } from '../../../src/shared/types';
import { WorkspaceSchema } from '../../../src/shared/schemas';

const mockLore = lore as jest.Mocked<typeof lore>;

interface MockEvent {
  tag: number;
  data: Record<string, unknown>;
}

// Builds a fake fluent executor matching the SDK's
// lore.<op>(globals, args).callback(cb).waitAsync() contract.
function fluentMock({ events = [], error }: { events?: MockEvent[]; error?: Error } = {}): unknown {
  const chain = {
    registeredCallback: undefined as ((event: unknown) => void) | undefined,
    callback: jest.fn((cb: (event: unknown) => void): unknown => {
      chain.registeredCallback = cb;
      return chain;
    }),
    waitAsync: jest.fn(async (): Promise<number> => {
      for (const event of events) {
        chain.registeredCallback?.({
          ...event,
          clone: () => ({ tag: event.tag, data: event.data }),
        });
      }
      if (error) {
        throw error;
      }
      return 0;
    }),
  };
  return chain;
}

function loreError(errorType: number, errorInner: string): Error {
  return new LoreError([{ tag: LoreEventTag.ERROR, data: { errorType, errorInner } }] as never);
}

function instanceEvent(data: {
  instanceId: string;
  path: string;
  branchName: string;
  branch?: string;
  revision?: string;
  stale?: boolean;
}): MockEvent {
  return {
    tag: LoreEventTag.REPOSITORY_INSTANCE,
    data: {
      instanceId: data.instanceId,
      path: data.path,
      branchName: data.branchName,
      branch: data.branch ?? 'branch-id',
      revision: data.revision ?? 'rev-hash',
      stale: data.stale ?? false,
    },
  };
}

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as never;

describe('WorkspaceService', () => {
  let tmpBase: string;
  let repo: Repository;
  let repositoryService: jest.Mocked<RepositoryService>;
  let loreRepositoryService: jest.Mocked<LoreRepositoryService>;
  let service: WorkspaceService;
  let worktreeRoot: string;
  let workspaceDir: string;
  const BRANCH = 'agent-x';

  beforeEach(() => {
    jest.clearAllMocks();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-workspace-test-'));
    repo = {
      id: '3b2f6f2e-4f9b-4a57-9d5c-2f6f2e4f9b4a',
      name: 'myrepo',
      url: 'lores://lore.example.com/myrepo',
      localPath: path.join(tmpBase, 'myrepo'),
      accentHue: 0,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    worktreeRoot = path.join(tmpBase, 'myrepo-wt');
    workspaceDir = path.join(worktreeRoot, BRANCH);

    repositoryService = {
      getById: jest.fn(async () => repo),
      getAll: jest.fn(async () => [repo]),
    } as unknown as jest.Mocked<RepositoryService>;

    loreRepositoryService = {
      switchBranch: jest.fn(async () => undefined),
      getFileStatus: jest.fn(async () => ({ untracked: [], unstaged: [], staged: [] })),
      getBranchDivergence: jest.fn(async () => ({
        state: 'inSync',
        latest: 'a',
        latestRemote: 'a',
      })),
    } as unknown as jest.Mocked<LoreRepositoryService>;

    service = new WorkspaceService(mockLog, repositoryService, loreRepositoryService, {
      port: 4599,
      tokenForWorkspace: () => 'tok-123',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('provision', () => {
    it('clones with the shared store, creates+switches the branch, writes hooks, and returns the instance', async () => {
      // Given: clone, branchCreate succeed and the instance shows up in the listing
      mockLore.repositoryClone.mockReturnValue(fluentMock() as never);
      mockLore.branchCreate.mockReturnValue(fluentMock() as never);
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [
            instanceEvent({
              instanceId: 'inst-1',
              path: workspaceDir,
              branchName: BRANCH,
              revision: 'r1',
            }),
          ],
        }) as never
      );

      // When: provisioning a workspace
      const workspace = await service.provision({ repositoryId: repo.id, branchName: BRANCH });

      // Then: the SDK is driven with shared-store clone + branch create
      expect(mockLore.repositoryClone).toHaveBeenCalledWith(
        { repositoryPath: workspaceDir },
        { repositoryUrl: repo.url, useSharedStore: true, sharedStorePath: '' }
      );
      expect(mockLore.branchCreate).toHaveBeenCalledWith(
        { repositoryPath: workspaceDir },
        { branch: BRANCH }
      );
      expect(loreRepositoryService.switchBranch).toHaveBeenCalledWith(workspaceDir, BRANCH);

      // And: the returned workspace is schema-valid and enriched with the repo id
      expect(WorkspaceSchema.safeParse(workspace).success).toBe(true);
      expect(workspace.instanceId).toBe('inst-1');
      expect(workspace.path).toBe(workspaceDir);
      expect(workspace.branchName).toBe(BRANCH);
      expect(workspace.repositoryId).toBe(repo.id);
      expect(typeof workspace.provisionedAt).toBe('string');

      // And: observer hooks are written into the new workspace
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ type: string; url: string }> }>>;
      };
      const events = Object.keys(settings.hooks).sort();
      expect(events).toEqual(
        [
          'Notification',
          'PostToolUse',
          'SessionEnd',
          'SessionStart',
          'Stop',
          'UserPromptSubmit',
        ].sort()
      );
      expect(settings.hooks['SessionStart']?.[0]?.hooks[0]).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:4599/hook/tok-123',
      });
    });

    it('refuses when the workspace directory already exists, without cloning', async () => {
      // Given: the target directory already exists
      fs.mkdirSync(workspaceDir, { recursive: true });

      // When/Then: provisioning is refused before any SDK call
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow('already exists');
      expect(mockLore.repositoryClone).not.toHaveBeenCalled();
    });

    it('refuses a branch name that escapes the worktree root', async () => {
      // When/Then: a traversal branch name is rejected before cloning
      await expect(
        service.provision({ repositoryId: repo.id, branchName: '../../escape' })
      ).rejects.toThrow('escapes');
      expect(mockLore.repositoryClone).not.toHaveBeenCalled();
    });

    it('rejects when the repository is unknown', async () => {
      // Given: no repository resolves for the id
      repositoryService.getById.mockResolvedValue(null);

      // When/Then: provisioning fails cleanly
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow('not found');
    });

    it('cleans up the partial checkout and does not register when the clone fails mid-flight', async () => {
      // Given: the clone rejects (e.g. server unreachable)
      mockLore.repositoryClone.mockReturnValue(
        fluentMock({ error: loreError(10, 'server unreachable') }) as never
      );

      // When: provisioning
      const promise = service.provision({ repositoryId: repo.id, branchName: BRANCH });

      // Then: it fails, the branch is never created, no instance listing happens,
      // and no orphan directory is left behind
      await expect(promise).rejects.toThrow(WorkspaceOperationError);
      expect(mockLore.branchCreate).not.toHaveBeenCalled();
      expect(mockLore.repositoryInstanceList).not.toHaveBeenCalled();
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });
  });

  describe('writeObserverHooks', () => {
    it('deep-merges into an existing settings.local.json without clobbering user content', async () => {
      // Given: a pre-existing settings file with user permissions and hooks
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: { allow: ['Bash(ls:*)'] },
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
            CustomEvent: [{ hooks: [{ type: 'command', command: 'echo custom' }] }],
          },
        })
      );

      // When: injecting observer hooks
      await service.writeObserverHooks(workspaceDir);

      // Then: user content survives and our hook is appended to SessionStart
      const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        permissions: { allow: string[] };
        hooks: Record<
          string,
          Array<{ hooks: Array<{ type: string; url?: string; command?: string }> }>
        >;
      };
      expect(merged.permissions).toEqual({ allow: ['Bash(ls:*)'] });
      expect(merged.hooks['CustomEvent']).toEqual([
        { hooks: [{ type: 'command', command: 'echo custom' }] },
      ]);
      expect(merged.hooks['SessionStart']).toHaveLength(2);
      expect(merged.hooks['SessionStart']?.[0]?.hooks[0]).toEqual({
        type: 'command',
        command: 'echo hi',
      });
      expect(merged.hooks['SessionStart']?.[1]?.hooks[0]).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:4599/hook/tok-123',
      });
      // And: the other observed events are present too
      expect(merged.hooks['Stop']?.[0]?.hooks[0]).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:4599/hook/tok-123',
      });
    });

    it('falls back to a generated token and default port when no observer config is given', async () => {
      // Given: a service constructed without an observer config
      const bareService = new WorkspaceService(mockLog, repositoryService, loreRepositoryService);
      fs.mkdirSync(workspaceDir, { recursive: true });

      // When: injecting hooks
      await bareService.writeObserverHooks(workspaceDir);

      // Then: a loopback hook URL is still written for every event
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ type: string; url: string }> }>>;
      };
      const url = settings.hooks['SessionStart']?.[0]?.hooks[0]?.url ?? '';
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/.+/);
    });
  });

  describe('list', () => {
    it('lists the repo instances as workspaces, keeps stale ones, and excludes the primary checkout', async () => {
      // Given: three instances — a workspace, a stale workspace, and the repo's own checkout
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [
            instanceEvent({ instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH }),
            instanceEvent({
              instanceId: 'inst-2',
              path: path.join(worktreeRoot, 'gone'),
              branchName: 'agent-y',
              stale: true,
            }),
            instanceEvent({ instanceId: 'primary', path: repo.localPath, branchName: 'main' }),
          ],
        }) as never
      );

      // When: listing workspaces for the repository
      const workspaces = await service.list(repo.id);

      // Then: the primary checkout is excluded and the stale flag is preserved
      expect(mockLore.repositoryInstanceList).toHaveBeenCalledWith(
        { repositoryPath: repo.localPath },
        {}
      );
      expect(workspaces.map(w => w.instanceId)).toEqual(['inst-1', 'inst-2']);
      expect(workspaces.every(w => w.repositoryId === repo.id)).toBe(true);
      expect(workspaces.find(w => w.instanceId === 'inst-2')?.stale).toBe(true);
    });

    it('rejects when the repository is unknown', async () => {
      // Given: no repository resolves
      repositoryService.getById.mockResolvedValue(null);

      // When/Then: listing fails cleanly
      await expect(service.list(repo.id)).rejects.toThrow('not found');
    });
  });

  describe('teardown', () => {
    function existingWorkspaceInstance(): void {
      fs.mkdirSync(workspaceDir, { recursive: true });
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [instanceEvent({ instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH })],
        }) as never
      );
      mockLore.repositoryInstancePrune.mockReturnValue(fluentMock() as never);
      mockLore.branchArchive.mockReturnValue(fluentMock() as never);
    }

    it('removes the directory, prunes the instance, archives the local branch, and records the remote as a server ask', async () => {
      // Given: a clean, tracked workspace
      existingWorkspaceInstance();

      // When: tearing it down
      const result = await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: the guards passed, the disk is cleaned, and the branch archived
      expect(loreRepositoryService.getFileStatus).toHaveBeenCalledWith(workspaceDir);
      expect(fs.existsSync(workspaceDir)).toBe(false);
      expect(mockLore.repositoryInstancePrune).toHaveBeenCalledWith(
        { repositoryPath: repo.localPath },
        {}
      );
      expect(mockLore.branchArchive).toHaveBeenCalledWith(
        { repositoryPath: repo.localPath },
        { branch: BRANCH }
      );
      expect(result).toEqual({
        workspaceId: 'inst-1',
        path: workspaceDir,
        directoryRemoved: true,
        localBranchRemoved: true,
        remoteBranchRemoved: false,
      });
    });

    it('resolves a workspace by path as well as by id', async () => {
      // Given: a clean, tracked workspace
      existingWorkspaceInstance();

      // When: tearing it down by path
      const result = await service.teardown({ path: workspaceDir, force: false });

      // Then: it is removed
      expect(result.directoryRemoved).toBe(true);
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });

    it('refuses when the workspace has uncommitted changes and force is false', async () => {
      // Given: a tracked workspace with dirty files
      existingWorkspaceInstance();
      loreRepositoryService.getFileStatus.mockResolvedValue({
        untracked: [],
        unstaged: [{ path: 'a.txt', isUntracked: false, isStaged: false, conflict: false }],
        staged: [],
      });

      // When/Then: teardown is refused and nothing is deleted
      await expect(service.teardown({ workspaceId: 'inst-1', force: false })).rejects.toThrow(
        'uncommitted'
      );
      expect(fs.existsSync(workspaceDir)).toBe(true);
      expect(mockLore.branchArchive).not.toHaveBeenCalled();
    });

    it('refuses when the workspace has unpushed commits and force is false', async () => {
      // Given: a tracked workspace that is ahead of the remote
      existingWorkspaceInstance();
      loreRepositoryService.getBranchDivergence.mockResolvedValue({
        state: 'ahead',
        latest: 'b',
        latestRemote: 'a',
      });

      // When/Then: teardown is refused
      await expect(service.teardown({ workspaceId: 'inst-1', force: false })).rejects.toThrow(
        'unpushed'
      );
      expect(fs.existsSync(workspaceDir)).toBe(true);
    });

    it('force removes a dirty workspace, skipping the clean guard', async () => {
      // Given: a dirty, tracked workspace
      existingWorkspaceInstance();
      loreRepositoryService.getFileStatus.mockResolvedValue({
        untracked: [],
        unstaged: [{ path: 'a.txt', isUntracked: false, isStaged: false, conflict: false }],
        staged: [],
      });

      // When: tearing down with force
      const result = await service.teardown({ workspaceId: 'inst-1', force: true });

      // Then: the clean guard is skipped and the workspace is removed
      expect(loreRepositoryService.getFileStatus).not.toHaveBeenCalled();
      expect(result.directoryRemoved).toBe(true);
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });

    it('refuses to remove a path that is not a tracked instance', async () => {
      // Given: an instance listing that does not contain the requested path
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [instanceEvent({ instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH })],
        }) as never
      );

      // When/Then: an untracked path is refused before touching disk
      await expect(
        service.teardown({ path: path.join(tmpBase, 'not-a-workspace'), force: true })
      ).rejects.toThrow(/not found|not a tracked instance/i);
      expect(mockLore.repositoryInstancePrune).not.toHaveBeenCalled();
    });

    it('refuses to remove the repository checkout itself', async () => {
      // Given: the repo's own checkout is (defensively) requested for teardown
      fs.mkdirSync(repo.localPath, { recursive: true });
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [
            instanceEvent({ instanceId: 'primary', path: repo.localPath, branchName: 'main' }),
          ],
        }) as never
      );

      // When/Then: teardown is refused
      await expect(service.teardown({ path: repo.localPath, force: true })).rejects.toThrow(
        'repository checkout'
      );
      expect(fs.existsSync(repo.localPath)).toBe(true);
    });

    it('refuses to follow a symlinked workspace path out of the workspace root', async () => {
      // Given: the tracked instance path is a symlink pointing elsewhere
      const realTarget = path.join(tmpBase, 'outside');
      fs.mkdirSync(realTarget, { recursive: true });
      fs.mkdirSync(worktreeRoot, { recursive: true });
      fs.symlinkSync(realTarget, workspaceDir);
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [instanceEvent({ instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH })],
        }) as never
      );

      // When/Then: teardown refuses to delete through the symlink
      await expect(service.teardown({ workspaceId: 'inst-1', force: true })).rejects.toThrow(
        'symlink'
      );
      expect(fs.existsSync(realTarget)).toBe(true);
    });

    it('continues (logging) when pruning the instance fails, still archiving the branch', async () => {
      // Given: a clean workspace whose prune fails
      fs.mkdirSync(workspaceDir, { recursive: true });
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [instanceEvent({ instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH })],
        }) as never
      );
      mockLore.repositoryInstancePrune.mockReturnValue(
        fluentMock({ error: loreError(9, 'prune failed') }) as never
      );
      mockLore.branchArchive.mockReturnValue(fluentMock() as never);

      // When: tearing down
      const result = await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: the directory is still removed and the branch archived
      expect(result.directoryRemoved).toBe(true);
      expect(result.localBranchRemoved).toBe(true);
      expect(mockLore.branchArchive).toHaveBeenCalled();
    });

    it('reports the local branch as not removed when archiving fails', async () => {
      // Given: a clean workspace whose branch archive fails
      fs.mkdirSync(workspaceDir, { recursive: true });
      mockLore.repositoryInstanceList.mockReturnValue(
        fluentMock({
          events: [instanceEvent({ instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH })],
        }) as never
      );
      mockLore.repositoryInstancePrune.mockReturnValue(fluentMock() as never);
      mockLore.branchArchive.mockReturnValue(
        fluentMock({ error: loreError(11, 'archive failed') }) as never
      );

      // When: tearing down
      const result = await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: the directory is gone but the local branch removal is reported false
      expect(result.directoryRemoved).toBe(true);
      expect(result.localBranchRemoved).toBe(false);
    });
  });

  describe('edge cases', () => {
    function rejectingChain(value: unknown): unknown {
      const chain = {
        callback: (): unknown => chain,
        waitAsync: async (): Promise<number> => {
          throw value;
        },
      };
      return chain;
    }

    it('setObserverConfig swaps the port and token used for hook URLs', async () => {
      // Given: a service whose observer config is replaced after construction
      service.setObserverConfig({ port: 5123, tokenForWorkspace: () => 'swapped' });
      fs.mkdirSync(workspaceDir, { recursive: true });

      // When: writing hooks
      await service.writeObserverHooks(workspaceDir);

      // Then: the new port and token appear in the URL
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ url: string }> }>>;
      };
      expect(settings.hooks['Stop']?.[0]?.hooks[0]?.url).toBe('http://127.0.0.1:5123/hook/swapped');
    });

    it('fails provisioning when the clone produced no tracked instance', async () => {
      // Given: clone + branch succeed, but no instance is registered
      mockLore.repositoryClone.mockReturnValue(fluentMock() as never);
      mockLore.branchCreate.mockReturnValue(fluentMock() as never);
      mockLore.repositoryInstanceList.mockReturnValue(fluentMock({ events: [] }) as never);

      // When/Then: provisioning fails clearly
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow('was not registered as an instance');
    });

    it('refuses a branch name that resolves to the worktree root itself', async () => {
      // When/Then: '.' collapses to the root and is rejected as not a subdirectory
      await expect(service.provision({ repositoryId: repo.id, branchName: '.' })).rejects.toThrow(
        'subdirectory'
      );
      expect(mockLore.repositoryClone).not.toHaveBeenCalled();
    });

    it('skips hook injection without clobbering a malformed existing settings file', async () => {
      // Given: an unparseable settings.local.json already on disk
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ not json');

      // When: injecting hooks
      await service.writeObserverHooks(workspaceDir);

      // Then: the malformed file is left untouched
      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{ not json');
    });

    it('wraps a plain SDK error into a WorkspaceOperationError with context', async () => {
      // Given: the instance listing rejects with a plain Error
      mockLore.repositoryInstanceList.mockReturnValue(rejectingChain(new Error('boom')) as never);

      // When/Then: the failure is wrapped with the operation context
      await expect(service.list(repo.id)).rejects.toThrow(WorkspaceOperationError);
      await expect(service.list(repo.id)).rejects.toThrow(
        'Failed to list workspace instances: boom'
      );
    });

    it('wraps a non-Error thrown value using its string form', async () => {
      // Given: the instance listing rejects with a bare string
      mockLore.repositoryInstanceList.mockReturnValue(rejectingChain('weird failure') as never);

      // When/Then: the string is carried into the wrapped message
      await expect(service.list(repo.id)).rejects.toThrow(
        'Failed to list workspace instances: weird failure'
      );
    });
  });
});

// Sanity: the module cleans up its own temp usage — no lingering promise
// rejection escapes the mocked SDK layer.
afterAll(async () => {
  await fsp.rm(path.join(os.tmpdir(), 'lore-workspace-nonexistent'), {
    recursive: true,
    force: true,
  });
});
