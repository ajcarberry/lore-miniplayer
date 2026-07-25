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
      branchInfo: jest.fn(),
      repositoryInstanceList: jest.fn(),
      repositoryInstancePrune: jest.fn(),
    },
  };
});

// The workspace registry (workspaces.json) resolves under Electron's userData
// directory; point it at a per-test temp dir so it exercises the real
// filesystem (mirrors the repository store test).
const mockUserData = { dir: '' };
jest.mock('electron', () => ({
  app: {
    getPath: (): string => mockUserData.dir,
  },
}));

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { lore, LoreError } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import { randomUUID } from 'node:crypto';
import {
  WorkspaceService,
  WorkspaceOperationError,
} from '../../../src/main/services/workspace-service';
import { WorkspaceRegistry } from '../../../src/main/services/workspace-store';
import { AgentObserverService } from '../../../src/main/services/agent-observer';
import type { RepositoryService } from '../../../src/main/services/repository';
import type { LoreRepositoryService } from '../../../src/main/services/lore-repository';
import type { Repository } from '../../../src/shared/types';
import { RepositorySchema, WorkspaceSchema } from '../../../src/shared/schemas';

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

interface InstanceData {
  instanceId: string;
  path: string;
  branchName: string;
  branch?: string;
  revision?: string;
  stale?: boolean;
}

function instanceEvent(data: InstanceData): MockEvent {
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

// Models Lore's PER-STORE instance registry (P18 live finding). The
// repository's primary checkout has a PRIVATE store that lists ONLY itself;
// shared-store clones list every shared member. `repositoryInstanceList` at a
// path returns only that path's store — the mock MUST NOT let the primary path
// see workspace instances, because that false behavior is exactly what shipped
// the bug this packet fixes.
class FakeStores {
  private readonly storeByPath = new Map<string, string>();
  private readonly membersByStore = new Map<string, Map<string, InstanceData>>();

  register(storeKey: string, instance: InstanceData): void {
    const key = path.resolve(instance.path);
    this.storeByPath.set(key, storeKey);
    const members = this.membersByStore.get(storeKey) ?? new Map<string, InstanceData>();
    members.set(key, instance);
    this.membersByStore.set(storeKey, members);
  }

  listAt(queriedPath: string): InstanceData[] {
    const storeKey = this.storeByPath.get(path.resolve(queriedPath));
    if (!storeKey) {
      return [];
    }
    return [...(this.membersByStore.get(storeKey)?.values() ?? [])];
  }

  install(): void {
    mockLore.repositoryInstanceList.mockImplementation(
      (globals: unknown) =>
        fluentMock({
          events: this.listAt((globals as { repositoryPath: string }).repositoryPath).map(
            instanceEvent
          ),
        }) as never
    );
  }
}

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never;

describe('WorkspaceService', () => {
  let tmpBase: string;
  let repo: Repository;
  let repositoryService: jest.Mocked<RepositoryService>;
  let loreRepositoryService: jest.Mocked<LoreRepositoryService>;
  let service: WorkspaceService;
  let stores: FakeStores;
  let worktreeRoot: string;
  let workspaceDir: string;
  const BRANCH = 'agent-x';
  const PROVISIONED_AT = '2026-07-22T00:00:00.000Z';

  // Seed the persistent registry (workspaces.json) directly with provisioned
  // worktree entries of `repo` (joined to it by url), standing in for a prior
  // provision without driving the SDK. The registry key is url — the seeded
  // entry gets its own uuid, NOT repo.id, proving list joins by url.
  async function seedRegistry(
    entries: Array<{
      path: string;
      branchName: string;
      provisionedAt?: string;
    }>
  ): Promise<void> {
    const store = new WorkspaceRegistry(mockLog);
    for (const entry of entries) {
      const at = entry.provisionedAt ?? PROVISIONED_AT;
      await store.upsertByLocalPath(
        RepositorySchema.parse({
          id: randomUUID(),
          name: entry.branchName,
          url: repo.url,
          localPath: entry.path,
          accentHue: 74,
          origin: 'provisioned',
          branchName: entry.branchName,
          provisionedAt: at,
          createdAt: at,
          updatedAt: at,
        })
      );
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-workspace-test-'));
    // The registry lives in its own userData dir, separate from the worktree tree.
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-workspace-userdata-'));
    repo = {
      id: '3b2f6f2e-4f9b-4a57-9d5c-2f6f2e4f9b4a',
      name: 'myrepo',
      url: 'lores://lore.example.com/myrepo',
      localPath: path.join(tmpBase, 'myrepo'),
      accentHue: 0,
      origin: 'attached',
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
      getWorkspaceRevisionStatus: jest.fn(async () => ({
        branchName: BRANCH,
        revision: 'a',
        divergence: { state: 'inSync', latest: 'a', latestRemote: 'a' },
      })),
      // Provision stamps the workspace's stable Lore id; default to none so
      // grouping falls back to url unless a test opts in.
      resolveRepositoryIdentity: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<LoreRepositoryService>;

    stores = new FakeStores();
    stores.install();
    mockLore.repositoryClone.mockReturnValue(fluentMock() as never);
    mockLore.branchCreate.mockReturnValue(fluentMock() as never);
    mockLore.branchArchive.mockReturnValue(fluentMock() as never);
    // No BRANCH_INFO by default: fork evidence degrades to unknown hashes.
    mockLore.branchInfo.mockReturnValue(fluentMock() as never);
    mockLore.repositoryInstancePrune.mockReturnValue(fluentMock() as never);

    service = new WorkspaceService(mockLog, repositoryService, loreRepositoryService, {
      port: 4599,
      tokenForWorkspace: () => 'tok-123',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(mockUserData.dir, { recursive: true, force: true });
  });

  describe('provision', () => {
    it('clones with the shared store, verifies via the WORKSPACE path, persists the registry entry, and returns the instance', async () => {
      // Given: the clone joins a shared store that self-reports this workspace
      stores.register('shared', {
        instanceId: 'inst-1',
        path: workspaceDir,
        branchName: BRANCH,
        revision: 'r1',
      });

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

      // And: verification queried the WORKSPACE's own store, never the primary's
      expect(mockLore.repositoryInstanceList).toHaveBeenCalledWith(
        { repositoryPath: workspaceDir },
        {}
      );
      expect(mockLore.repositoryInstanceList).not.toHaveBeenCalledWith(
        { repositoryPath: repo.localPath },
        {}
      );

      // And: the returned workspace is schema-valid and enriched with the repo id
      expect(WorkspaceSchema.safeParse(workspace).success).toBe(true);
      expect(workspace.instanceId).toBe('inst-1');
      expect(workspace.path).toBe(workspaceDir);
      expect(workspace.branchName).toBe(BRANCH);
      expect(workspace.repositoryId).toBe(repo.id);
      expect(typeof workspace.provisionedAt).toBe('string');

      // And: a unified provisioned entry is persisted to workspaces.json
      // (survives a reload), joined to the repo by url
      const reloaded = await new WorkspaceRegistry(mockLog).findByLocalPath(workspaceDir);
      expect(reloaded).toMatchObject({
        url: repo.url,
        localPath: workspaceDir,
        branchName: BRANCH,
        origin: 'provisioned',
        provisionedAt: workspace.provisionedAt,
      });

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

    it('refuses when the workspace directory already exists and is not an adoptable instance', async () => {
      // Given: the target directory exists but self-reports no matching instance
      fs.mkdirSync(workspaceDir, { recursive: true });

      // When/Then: provisioning is refused before any clone
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow('already exists');
      expect(mockLore.repositoryClone).not.toHaveBeenCalled();
    });

    it('adopts an existing on-disk workspace whose branch matches instead of failing', async () => {
      // Given: an orphaned workspace on disk that self-reports a matching branch
      // (provisioned by the pre-fix flow — no registry entry exists)
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', {
        instanceId: 'inst-orphan',
        path: workspaceDir,
        branchName: BRANCH,
        revision: 'r9',
      });

      // When: provisioning the same branch again
      const workspace = await service.provision({ repositoryId: repo.id, branchName: BRANCH });

      // Then: it is adopted (not re-cloned) and registered
      expect(mockLore.repositoryClone).not.toHaveBeenCalled();
      expect(workspace.instanceId).toBe('inst-orphan');
      expect(workspace.path).toBe(workspaceDir);
      const reloaded = await new WorkspaceRegistry(mockLog).findByLocalPath(workspaceDir);
      expect(reloaded).toMatchObject({ branchName: BRANCH, url: repo.url, origin: 'provisioned' });
    });

    it('provisions a workspace whose branch name contains a slash (registry name schema regression)', async () => {
      // Given: a "prefix/name" branch, as agent worktrees use (e.g. "test/WT1")
      const slashedBranch = 'test/WT1';
      const slashedDir = path.join(worktreeRoot, slashedBranch);
      stores.register('shared', {
        instanceId: 'inst-slash',
        path: slashedDir,
        branchName: slashedBranch,
        revision: 'r1',
      });

      // When: provisioning with the slashed branch name
      const workspace = await service.provision({
        repositoryId: repo.id,
        branchName: slashedBranch,
      });

      // Then: it succeeds, and the persisted registry entry (named for the
      // branch, per upsertProvisioned) validates against RepositorySchema
      expect(workspace.branchName).toBe(slashedBranch);
      const reloaded = await new WorkspaceRegistry(mockLog).findByLocalPath(slashedDir);
      expect(reloaded).toMatchObject({
        name: slashedBranch,
        branchName: slashedBranch,
        origin: 'provisioned',
      });
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
      // no orphan directory is left, and nothing is persisted
      await expect(promise).rejects.toThrow(WorkspaceOperationError);
      expect(mockLore.branchCreate).not.toHaveBeenCalled();
      expect(mockLore.repositoryInstanceList).not.toHaveBeenCalled();
      expect(fs.existsSync(workspaceDir)).toBe(false);
      await expect(new WorkspaceRegistry(mockLog).all()).resolves.toEqual([]);
    });

    it('refuses a second provision for the same workspace while the first is still in flight (P10)', async () => {
      // Given: a clone that hangs until released, and a shared store that will
      // self-report the workspace once the clone lands
      let releaseClone!: () => void;
      const cloneGate = new Promise<void>(resolve => {
        releaseClone = resolve;
      });
      const chain = {
        callback: (): unknown => chain,
        waitAsync: async (): Promise<number> => {
          await cloneGate;
          return 0;
        },
      };
      mockLore.repositoryClone.mockReturnValue(chain as never);
      stores.register('shared', {
        instanceId: 'inst-1',
        path: workspaceDir,
        branchName: BRANCH,
        revision: 'r1',
      });

      // When: a second provision for the same branch starts while the first
      // is still mid-clone
      const first = service.provision({ repositoryId: repo.id, branchName: BRANCH });
      while (mockLore.repositoryClone.mock.calls.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const second = service
        .provision({ repositoryId: repo.id, branchName: BRANCH })
        .catch((error: unknown) => error as Error);
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // Then: no second clone ever started into the same directory (whose
      // failure cleanup would rm -rf the first's half-built checkout)
      expect(mockLore.repositoryClone).toHaveBeenCalledTimes(1);
      // And: the second call was refused, while the first still completes
      const secondOutcome = await second;
      expect(secondOutcome).toBeInstanceOf(Error);
      expect((secondOutcome as Error).message).toContain('already in flight');
      releaseClone();
      await expect(first).resolves.toMatchObject({ path: workspaceDir, branchName: BRANCH });
    });

    it('wraps a non-Error clone rejection using its string form', async () => {
      // Given: the clone rejects with a bare string
      const chain = {
        callback: (): unknown => chain,
        waitAsync: async (): Promise<number> => {
          throw 'weird failure';
        },
      };
      mockLore.repositoryClone.mockReturnValue(chain as never);

      // When/Then: the string is carried into the wrapped message
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow(/Failed to clone workspace .*: weird failure/);
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

    it('skips hook writing and logs when no observer config has been injected', async () => {
      // Given: a service constructed without an observer config (C31: the old
      // randomUUID fallback minted tokens the listener could never
      // authenticate, so a hook written under it could only ever 403)
      const bareService = new WorkspaceService(mockLog, repositoryService, loreRepositoryService);
      fs.mkdirSync(workspaceDir, { recursive: true });

      // When: injecting hooks
      await bareService.writeObserverHooks(workspaceDir);

      // Then: nothing is written and the skip is logged
      expect(fs.existsSync(path.join(workspaceDir, '.claude', 'settings.local.json'))).toBe(false);
      expect((mockLog as unknown as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
        'No observer config injected; skipping observer hook write',
        expect.objectContaining({ operation: 'workspace:writeObserverHooks' })
      );
    });

    it('re-injection replaces the prior observer hook groups instead of duplicating them', async () => {
      // Given: a workspace already carrying observer hooks from a previous run
      // (stale port + token) alongside a user-authored hook
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'echo hi' }] },
              { hooks: [{ type: 'http', url: 'http://127.0.0.1:41500/hook/stale-token' }] },
            ],
            Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:41501/hook/stale-token' }] }],
          },
        })
      );

      // When: injecting observer hooks again (fresh port + token)
      await service.writeObserverHooks(workspaceDir);

      // Then: exactly one observer group remains per event — the fresh one —
      // and the user-authored hook is untouched
      const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<
          string,
          Array<{ hooks: Array<{ type: string; url?: string; command?: string }> }>
        >;
      };
      expect(merged.hooks['SessionStart']).toEqual([
        { hooks: [{ type: 'command', command: 'echo hi' }] },
        { hooks: [{ type: 'http', url: 'http://127.0.0.1:4599/hook/tok-123' }] },
      ]);
      expect(merged.hooks['Stop']).toEqual([
        { hooks: [{ type: 'http', url: 'http://127.0.0.1:4599/hook/tok-123' }] },
      ]);
    });

    it('is idempotent: writing twice yields a single observer hook group per event', async () => {
      // Given: a bare workspace directory
      fs.mkdirSync(workspaceDir, { recursive: true });

      // When: injecting observer hooks twice (provision + startup re-injection)
      await service.writeObserverHooks(workspaceDir);
      await service.writeObserverHooks(workspaceDir);

      // Then: every observed event carries exactly one hook group
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ type: string; url: string }> }>>;
      };
      for (const event of Object.keys(settings.hooks)) {
        expect(settings.hooks[event]).toHaveLength(1);
      }
    });

    it('re-writes hooks for provisioned registry entries at startup and skips missing directories (C53)', async () => {
      // Given: two registered provisioned workspaces from a previous run — one
      // on disk, one whose directory is gone
      const goneDir = path.join(worktreeRoot, 'gone');
      fs.mkdirSync(workspaceDir, { recursive: true });
      await seedRegistry([
        { path: workspaceDir, branchName: BRANCH },
        { path: goneDir, branchName: 'agent-y' },
      ]);

      // When: startup re-injection runs
      await service.reinjectObserverHooks();

      // Then: the on-disk workspace has hooks embedding the CURRENT config's
      // port + token; the missing one is skipped without throwing
      const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ type: string; url: string }> }>>;
      };
      expect(settings.hooks['SessionStart']?.[0]?.hooks[0]).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:4599/hook/tok-123',
      });
      expect(fs.existsSync(goneDir)).toBe(false);
    });

    it('startup re-injection registers tokens the live listener accepts (C53)', async () => {
      // Given: a workspace provisioned by a PREVIOUS app run (registry entry
      // exists; the observer's in-memory token maps are empty — the restart)
      fs.mkdirSync(workspaceDir, { recursive: true });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);
      const observer = new AgentObserverService(mockLog, { port: 0 });
      await observer.start();
      try {
        service.setObserverConfig(observer.getObserverConfig());

        // When: startup re-injection runs
        await service.reinjectObserverHooks();

        // Then: the token embedded in the re-written hook URL authenticates
        // against the live listener (200, not 403)
        const settingsPath = path.join(workspaceDir, '.claude', 'settings.local.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
          hooks: Record<string, Array<{ hooks: Array<{ url: string }> }>>;
        };
        const url = new URL(settings.hooks['SessionStart']?.[0]?.hooks[0]?.url ?? '');
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request(
            {
              host: url.hostname,
              port: url.port,
              path: url.pathname,
              method: 'POST',
              headers: { 'content-type': 'application/json' },
            },
            res => {
              res.on('data', () => undefined);
              res.on('end', () => resolve(res.statusCode ?? 0));
            }
          );
          req.on('error', reject);
          req.end(JSON.stringify({ session_id: 'sess-1', hook_event_name: 'SessionStart' }));
        });
        expect(status).toBe(200);
      } finally {
        await observer.stop();
      }
    });

    it('refuses to write through a symlinked .claude directory that escapes the workspace', async () => {
      // Given: `.claude` inside the workspace is a symlink pointing OUTSIDE it
      const outside = path.join(tmpBase, 'victim-claude');
      fs.mkdirSync(outside, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.symlinkSync(outside, path.join(workspaceDir, '.claude'));

      // When: injecting observer hooks
      await service.writeObserverHooks(workspaceDir);

      // Then: nothing is written through the symlink and the refusal is logged
      expect(fs.existsSync(path.join(outside, 'settings.local.json'))).toBe(false);
      expect((mockLog as unknown as { error: jest.Mock }).error).toHaveBeenCalledWith(
        'Refusing to write observer hooks through a symlinked settings path',
        expect.objectContaining({ operation: 'workspace:writeObserverHooks' })
      );
    });
  });

  describe('list', () => {
    it('lists workspaces from the registry, enriches from each own path, and marks a missing directory stale', async () => {
      // Given: two registered workspaces — one present, one whose dir is gone
      const goneDir = path.join(worktreeRoot, 'gone');
      fs.mkdirSync(workspaceDir, { recursive: true });
      await seedRegistry([
        { path: workspaceDir, branchName: BRANCH },
        { path: goneDir, branchName: 'agent-y' },
      ]);
      stores.register('shared', {
        instanceId: 'inst-1',
        path: workspaceDir,
        branchName: BRANCH,
        revision: 'r1',
      });

      // When: listing workspaces for the repository
      const workspaces = await service.list(repo.id);

      // Then: the present one is enriched (not stale), the missing one is stale
      const present = workspaces.find(w => w.path === workspaceDir);
      const gone = workspaces.find(w => w.path === goneDir);
      expect(present?.instanceId).toBe('inst-1');
      expect(present?.revision).toBe('r1');
      expect(gone?.revision).toBe('');
      expect(gone?.branchName).toBe('agent-y');
      expect(workspaces.every(w => w.repositoryId === repo.id)).toBe(true);

      // Regression: the primary checkout's store is NEVER consulted for discovery
      const listCalls = mockLore.repositoryInstanceList.mock.calls as Array<
        [{ repositoryPath: string }, unknown]
      >;
      expect(listCalls.every(([g]) => g.repositoryPath !== repo.localPath)).toBe(true);
    });

    it('marks a workspace stale when its store query fails instead of throwing', async () => {
      // Given: a registered workspace whose directory exists but whose store errors
      fs.mkdirSync(workspaceDir, { recursive: true });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);
      mockLore.repositoryInstanceList.mockImplementation(() => {
        const chain = {
          callback: (): unknown => chain,
          waitAsync: async (): Promise<number> => {
            throw new Error('store unavailable');
          },
        };
        return chain as never;
      });

      // When/Then: list degrades to a stale row rather than throwing
      const workspaces = await service.list(repo.id);
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.revision).toBe('');
    });

    it('returns an empty list when nothing is registered', async () => {
      // When/Then: no registry entries -> no workspaces
      await expect(service.list(repo.id)).resolves.toEqual([]);
    });

    it('rejects when the repository is unknown', async () => {
      // Given: no repository resolves
      repositoryService.getById.mockResolvedValue(null);

      // When/Then: listing fails cleanly
      await expect(service.list(repo.id)).rejects.toThrow('not found');
    });

    it('includes an attached-origin sibling of the same Lore repo, enriched the same way as a provisioned member', async () => {
      // Given: another attached checkout of the SAME Lore repo (e.g. the
      // user's "adfa" folder) — a real registry entry, not a worktree
      const siblingDir = path.join(tmpBase, 'adfa');
      fs.mkdirSync(siblingDir, { recursive: true });
      const store = new WorkspaceRegistry(mockLog);
      await store.upsertById(
        RepositorySchema.parse({
          id: randomUUID(),
          name: 'adfa',
          url: repo.url,
          localPath: siblingDir,
          accentHue: 74,
          origin: 'attached',
          createdAt: PROVISIONED_AT,
          updatedAt: PROVISIONED_AT,
        })
      );
      stores.register('adfa-store', {
        instanceId: 'inst-adfa',
        path: siblingDir,
        branchName: 'main',
        revision: 'r-adfa',
      });

      // When: listing the anchor repo's workspaces
      const workspaces = await service.list(repo.id);

      // Then: the attached sibling appears, enriched from its own path exactly
      // like a provisioned member would be
      const sibling = workspaces.find(w => w.path === siblingDir);
      expect(sibling).toBeDefined();
      expect(sibling?.instanceId).toBe('inst-adfa');
      expect(sibling?.branchName).toBe('main');
      expect(sibling?.repositoryId).toBe(repo.id);
      // And: it never claims a provisionedAt it never had
      expect(sibling?.provisionedAt).toBeUndefined();
    });

    it('does not duplicate the anchor: excludes its own registry entry from the member list', async () => {
      // Given: the anchor repo's own row is present in the shared registry
      // (RepositoryService and WorkspaceService share one file post-U1)
      const store = new WorkspaceRegistry(mockLog);
      await store.upsertById(
        RepositorySchema.parse({
          id: repo.id,
          name: repo.name,
          url: repo.url,
          localPath: repo.localPath,
          accentHue: 74,
          origin: 'attached',
          createdAt: PROVISIONED_AT,
          updatedAt: PROVISIONED_AT,
        })
      );

      // When: listing the anchor repo's workspaces
      const workspaces = await service.list(repo.id);

      // Then: the anchor's own path never appears as a member (workspace-model
      // re-adds it separately, marked isActive)
      expect(workspaces.some(w => w.path === repo.localPath)).toBe(false);
    });

    it('excludes an attached-origin entry belonging to an unrelated Lore repo', async () => {
      // Given: an attached checkout of a DIFFERENT repo (different url, no
      // shared loreRepositoryId)
      const unrelatedDir = path.join(tmpBase, 'other-repo');
      fs.mkdirSync(unrelatedDir, { recursive: true });
      const store = new WorkspaceRegistry(mockLog);
      await store.upsertById(
        RepositorySchema.parse({
          id: randomUUID(),
          name: 'other-repo',
          url: 'lores://lore.example.com/unrelated',
          localPath: unrelatedDir,
          accentHue: 172,
          origin: 'attached',
          createdAt: PROVISIONED_AT,
          updatedAt: PROVISIONED_AT,
        })
      );

      // When: listing the anchor repo's workspaces
      const workspaces = await service.list(repo.id);

      // Then: the unrelated repo's entry is excluded
      expect(workspaces.some(w => w.path === unrelatedDir)).toBe(false);
    });

    it('lists a stale attached-origin sibling whose directory is gone', async () => {
      // Given: an attached sibling registry entry whose directory no longer exists
      const goneDir = path.join(tmpBase, 'gone-adfa');
      const store = new WorkspaceRegistry(mockLog);
      await store.upsertById(
        RepositorySchema.parse({
          id: randomUUID(),
          name: 'gone-adfa',
          url: repo.url,
          localPath: goneDir,
          accentHue: 296,
          origin: 'attached',
          createdAt: PROVISIONED_AT,
          updatedAt: PROVISIONED_AT,
        })
      );

      // When: listing the anchor repo's workspaces
      const workspaces = await service.list(repo.id);

      // Then: it is still listed as a stale row rather than dropped or throwing
      const gone = workspaces.find(w => w.path === goneDir);
      expect(gone).toBeDefined();
      expect(gone?.revision).toBe('');
      expect(gone?.branchName).toBe('gone-adfa');
    });
  });

  describe('loreRepositoryId grouping', () => {
    // Seed a provisioned entry with an explicit url + id, bypassing the
    // url-only seedRegistry so the two grouping keys can diverge.
    async function seedProvisioned(entry: {
      path: string;
      url: string;
      loreRepositoryId?: string;
      branchName: string;
    }): Promise<void> {
      const store = new WorkspaceRegistry(mockLog);
      await store.upsertByLocalPath(
        RepositorySchema.parse({
          id: randomUUID(),
          name: entry.branchName,
          url: entry.url,
          ...(entry.loreRepositoryId ? { loreRepositoryId: entry.loreRepositoryId } : {}),
          localPath: entry.path,
          accentHue: 74,
          origin: 'provisioned',
          branchName: entry.branchName,
          provisionedAt: PROVISIONED_AT,
          createdAt: PROVISIONED_AT,
          updatedAt: PROVISIONED_AT,
        })
      );
    }

    it('groups a worktree by loreRepositoryId even when its url has drifted', async () => {
      // Given: the anchor carries a stable id; its worktree shares that id but a
      // DIFFERENT url (e.g. anchor healed to a composed url, worktree recorded a
      // scheme variant)
      repo.loreRepositoryId = '019f6e08-stable-id';
      const matchDir = path.join(worktreeRoot, BRANCH);
      fs.mkdirSync(matchDir, { recursive: true });
      await seedProvisioned({
        path: matchDir,
        url: 'lore://drifted.example/other',
        loreRepositoryId: '019f6e08-stable-id',
        branchName: BRANCH,
      });
      stores.register('shared', {
        instanceId: 'inst-match',
        path: matchDir,
        branchName: BRANCH,
        revision: 'r1',
      });

      // When: listing the repo's workspaces
      const workspaces = await service.list(repo.id);

      // Then: the id-matched worktree is found despite the url mismatch
      expect(workspaces.map(w => w.path)).toEqual([matchDir]);
    });

    it('excludes a url-sharing worktree whose loreRepositoryId differs (id beats url)', async () => {
      // Given: the anchor has an id; a decoy worktree shares the anchor's url but
      // reports a DIFFERENT id (a different Lore repo that happens to collide on url)
      repo.loreRepositoryId = 'anchor-id';
      const decoyDir = path.join(worktreeRoot, 'decoy');
      fs.mkdirSync(decoyDir, { recursive: true });
      await seedProvisioned({
        path: decoyDir,
        url: repo.url,
        loreRepositoryId: 'other-id',
        branchName: 'decoy',
      });

      // When: listing
      const workspaces = await service.list(repo.id);

      // Then: the decoy is excluded — matching id wins over matching url
      expect(workspaces).toEqual([]);
    });

    it('stamps the workspace loreRepositoryId on provision', async () => {
      // Given: the workspace checkout self-reports its stable Lore id
      loreRepositoryService.resolveRepositoryIdentity.mockResolvedValue({
        url: 'lores://lore.example.com/myrepo',
        loreRepositoryId: '019f6e08-provisioned',
      });
      stores.register('shared', {
        instanceId: 'inst-1',
        path: workspaceDir,
        branchName: BRANCH,
        revision: 'r1',
      });

      // When: provisioning
      await service.provision({ repositoryId: repo.id, branchName: BRANCH });

      // Then: identity is resolved at the workspace's OWN path and persisted
      expect(loreRepositoryService.resolveRepositoryIdentity).toHaveBeenCalledWith(workspaceDir);
      const persisted = await new WorkspaceRegistry(mockLog).findByLocalPath(workspaceDir);
      expect(persisted?.loreRepositoryId).toBe('019f6e08-provisioned');
    });
  });

  describe('teardown', () => {
    let siblingDir: string;

    beforeEach(() => {
      siblingDir = path.join(worktreeRoot, 'agent-y');
    });

    async function registeredWorkspace(withSibling: boolean): Promise<void> {
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      const entries = [{ path: workspaceDir, branchName: BRANCH }];
      if (withSibling) {
        fs.mkdirSync(siblingDir, { recursive: true });
        stores.register('shared', {
          instanceId: 'inst-2',
          path: siblingDir,
          branchName: 'agent-y',
        });
        entries.push({ path: siblingDir, branchName: 'agent-y' });
      }
      await seedRegistry(entries);
    }

    it('removes the dir, drops the registry entry, and prunes + archives via a sibling in the shared store', async () => {
      // Given: a clean, tracked workspace with a sibling sharing its store
      await registeredWorkspace(true);

      // When: tearing it down
      await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: guards ran, the dir is gone, and the registry entry is removed
      expect(loreRepositoryService.getFileStatus).toHaveBeenCalledWith(workspaceDir);
      expect(fs.existsSync(workspaceDir)).toBe(false);
      await expect(
        new WorkspaceRegistry(mockLog).findByLocalPath(workspaceDir)
      ).resolves.toBeUndefined();

      // And: prune + archive targeted the SIBLING's path (the shared store), not
      // the primary checkout
      expect(mockLore.repositoryInstancePrune).toHaveBeenCalledWith(
        { repositoryPath: siblingDir },
        {}
      );
      expect(mockLore.branchArchive).toHaveBeenCalledWith(
        { repositoryPath: siblingDir },
        { branch: BRANCH }
      );
    });

    it('skips prune + archive (logging) when tearing down the last workspace of a repo', async () => {
      // Given: the only tracked workspace of the repo
      await registeredWorkspace(false);

      // When: tearing it down
      await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: the dir is removed and the entry dropped, but no store handle
      // remains to prune/archive against
      expect(fs.existsSync(workspaceDir)).toBe(false);
      expect(mockLore.repositoryInstancePrune).not.toHaveBeenCalled();
      expect(mockLore.branchArchive).not.toHaveBeenCalled();
      expect((mockLog as unknown as { info: jest.Mock }).info).toHaveBeenCalledWith(
        expect.stringContaining('no sibling workspace'),
        expect.objectContaining({ operation: 'workspace:teardown' })
      );
    });

    it('resolves a workspace by path as well as by id', async () => {
      // Given: a clean, tracked workspace with a sibling
      await registeredWorkspace(true);

      // When: tearing it down by path
      await service.teardown({ path: workspaceDir, force: false });

      // Then: it is removed
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });

    it('refuses when the workspace has uncommitted changes and force is false', async () => {
      // Given: a tracked workspace with dirty files
      await registeredWorkspace(true);
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
      await registeredWorkspace(true);
      loreRepositoryService.getWorkspaceRevisionStatus.mockResolvedValue({
        branchName: BRANCH,
        revision: 'b',
        divergence: { state: 'ahead', latest: 'b', latestRemote: 'a' },
      });

      // When/Then: teardown is refused
      await expect(service.teardown({ workspaceId: 'inst-1', force: false })).rejects.toThrow(
        'unpushed'
      );
      expect(fs.existsSync(workspaceDir)).toBe(true);
    });

    it('refuses when the branch has diverged from the remote and force is false (C52)', async () => {
      // Given: a tracked workspace whose branch is behindOrDiverged — its
      // local commits are not provably on the remote (remote moved on too)
      await registeredWorkspace(true);
      loreRepositoryService.getWorkspaceRevisionStatus.mockResolvedValue({
        branchName: BRANCH,
        revision: 'b',
        divergence: { state: 'behindOrDiverged', latest: 'b', latestRemote: 'c' },
      });

      // When/Then: unforced teardown is refused and nothing is deleted
      await expect(service.teardown({ workspaceId: 'inst-1', force: false })).rejects.toThrow(
        'unpushed'
      );
      expect(fs.existsSync(workspaceDir)).toBe(true);
      expect(mockLore.branchArchive).not.toHaveBeenCalled();
    });

    it('refuses a never-pushed branch whose tip moved past its fork point (C52)', async () => {
      // Given: divergence is unknown (no remote tip — the branch was never
      // pushed) and the branch tip has moved past its creation fork point:
      // committed-but-unpushed agent work
      await registeredWorkspace(true);
      loreRepositoryService.getWorkspaceRevisionStatus.mockResolvedValue({
        branchName: BRANCH,
        revision: '',
        divergence: { state: 'unknown', latest: '', latestRemote: '' },
      });
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_INFO,
              data: { latest: 'c2c2c2', branchPoint: 'c0c0c0' },
            },
          ],
        }) as never
      );

      // When/Then: unforced teardown is refused and nothing is deleted
      await expect(service.teardown({ workspaceId: 'inst-1', force: false })).rejects.toThrow(
        'unpushed'
      );
      expect(fs.existsSync(workspaceDir)).toBe(true);
      expect(mockLore.branchArchive).not.toHaveBeenCalled();
    });

    it('allows a freshly provisioned never-pushed branch still at its fork point (C52)', async () => {
      // Given: unknown divergence but the tip IS the fork point — the branch
      // has no commits of its own (the fork revision came from the clone), so
      // nothing exists only locally
      await registeredWorkspace(true);
      loreRepositoryService.getWorkspaceRevisionStatus.mockResolvedValue({
        branchName: BRANCH,
        revision: '',
        divergence: { state: 'unknown', latest: '', latestRemote: '' },
      });
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_INFO,
              data: { latest: 'c0c0c0', branchPoint: 'c0c0c0' },
            },
          ],
        }) as never
      );

      // When: unforced teardown
      await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: allowed — the guard must not false-positive a clean fresh worktree
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });

    it('fails closed when unknown divergence yields no fork evidence (C52)', async () => {
      // Given: unknown divergence and BRANCH_INFO streams nothing, so the
      // tip and fork point are unresolvable
      await registeredWorkspace(true);
      loreRepositoryService.getWorkspaceRevisionStatus.mockResolvedValue({
        branchName: BRANCH,
        revision: '',
        divergence: { state: 'unknown', latest: '', latestRemote: '' },
      });

      // When/Then: unforced teardown is refused rather than guessing
      await expect(service.teardown({ workspaceId: 'inst-1', force: false })).rejects.toThrow(
        'unpushed'
      );
      expect(fs.existsSync(workspaceDir)).toBe(true);
    });

    it('force removes a dirty workspace, skipping the clean guard', async () => {
      // Given: a dirty, tracked workspace
      await registeredWorkspace(true);
      loreRepositoryService.getFileStatus.mockResolvedValue({
        untracked: [],
        unstaged: [{ path: 'a.txt', isUntracked: false, isStaged: false, conflict: false }],
        staged: [],
      });

      // When: tearing down with force
      await service.teardown({ workspaceId: 'inst-1', force: true });

      // Then: the clean guard is skipped and the workspace is removed
      expect(loreRepositoryService.getFileStatus).not.toHaveBeenCalled();
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });

    it('refuses to remove a path that is not a registered workspace', async () => {
      // Given: a registry with one workspace that is NOT the requested path
      await registeredWorkspace(false);

      // When/Then: an untracked path is refused before touching disk
      await expect(
        service.teardown({ path: path.join(tmpBase, 'not-a-workspace'), force: true })
      ).rejects.toThrow(/not found|not a tracked instance/i);
      expect(mockLore.repositoryInstancePrune).not.toHaveBeenCalled();
    });

    it('refuses to remove the repository checkout itself even if it slips into the registry', async () => {
      // Given: the repo's own checkout is (defensively) present as a registry entry
      fs.mkdirSync(repo.localPath, { recursive: true });
      stores.register('shared', {
        instanceId: 'primary',
        path: repo.localPath,
        branchName: 'main',
      });
      await seedRegistry([{ path: repo.localPath, branchName: 'main' }]);

      // When/Then: teardown is refused by the containment guard
      await expect(service.teardown({ path: repo.localPath, force: true })).rejects.toThrow(
        'repository checkout'
      );
      expect(fs.existsSync(repo.localPath)).toBe(true);
    });

    it('refuses to follow a symlinked workspace path out of the workspace root', async () => {
      // Given: the tracked workspace path is a symlink pointing elsewhere
      const realTarget = path.join(tmpBase, 'outside');
      fs.mkdirSync(realTarget, { recursive: true });
      fs.mkdirSync(worktreeRoot, { recursive: true });
      fs.symlinkSync(realTarget, workspaceDir);
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);

      // When/Then: teardown refuses to delete through the symlink
      await expect(service.teardown({ workspaceId: 'inst-1', force: true })).rejects.toThrow(
        'symlink'
      );
      expect(fs.existsSync(realTarget)).toBe(true);
    });

    it('continues (logging) when pruning the instance fails, still archiving the branch', async () => {
      // Given: a clean workspace with a sibling whose prune fails
      await registeredWorkspace(true);
      mockLore.repositoryInstancePrune.mockReturnValue(
        fluentMock({ error: loreError(9, 'prune failed') }) as never
      );

      // When: tearing down
      await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: the directory is still removed and the branch archived
      expect(fs.existsSync(workspaceDir)).toBe(false);
      expect(mockLore.branchArchive).toHaveBeenCalled();
    });

    it('continues (logging) when archiving the branch fails', async () => {
      // Given: a clean workspace with a sibling whose branch archive fails
      await registeredWorkspace(true);
      mockLore.branchArchive.mockReturnValue(
        fluentMock({ error: loreError(11, 'archive failed') }) as never
      );

      // When: tearing down
      await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: the directory is gone despite the failed archive (logged)
      expect(fs.existsSync(workspaceDir)).toBe(false);
      expect((mockLog as unknown as { error: jest.Mock }).error).toHaveBeenCalledWith(
        expect.stringContaining('archive'),
        expect.objectContaining({ operation: 'workspace:teardown' })
      );
    });

    async function registerAttachedSibling(): Promise<string> {
      const siblingDir = path.join(tmpBase, 'adfa');
      fs.mkdirSync(siblingDir, { recursive: true });
      stores.register('adfa-store', {
        instanceId: 'inst-adfa',
        path: siblingDir,
        branchName: 'main',
      });
      await new WorkspaceRegistry(mockLog).upsertById(
        RepositorySchema.parse({
          id: randomUUID(),
          name: 'adfa',
          url: repo.url,
          localPath: siblingDir,
          accentHue: 74,
          origin: 'attached',
          createdAt: PROVISIONED_AT,
          updatedAt: PROVISIONED_AT,
        })
      );
      return siblingDir;
    }

    it('refuses to close a clean attached-origin sibling without force (repository checkouts always require confirmation)', async () => {
      // Given: a clean, self-reporting attached sibling of the anchor repo
      const siblingDir = await registerAttachedSibling();

      // When/Then: a bare teardown request (no force) is refused, even though
      // nothing is dirty or unpushed, and nothing is removed
      await expect(service.teardown({ workspaceId: 'inst-adfa', force: false })).rejects.toThrow(
        'repository checkout'
      );
      expect(fs.existsSync(siblingDir)).toBe(true);
      await expect(
        new WorkspaceRegistry(mockLog).findByLocalPath(siblingDir)
      ).resolves.toBeDefined();
    });

    it('tears down a non-anchor attached-origin sibling when force is set (amendment: ✕ works regardless of origin)', async () => {
      // Given: an attached sibling of the anchor repo, clean and self-reporting
      const siblingDir = await registerAttachedSibling();

      // When: tearing it down with explicit confirmation
      await service.teardown({ workspaceId: 'inst-adfa', force: true });

      // Then: the "repo's own checkout" guard does not (wrongly) refuse an
      // attached entry that legitimately IS its own repo record, and the
      // directory + registry entry are removed
      expect(fs.existsSync(siblingDir)).toBe(false);
      await expect(
        new WorkspaceRegistry(mockLog).findByLocalPath(siblingDir)
      ).resolves.toBeUndefined();
    });

    it('never archives a branch named after an attached entry display name (C51)', async () => {
      // Given: an attached sibling — whose registry entry carries NO
      // provisioned branchName, only its user-facing display name 'adfa' —
      // plus a provisioned worktree sharing the store, so a sibling handle
      // exists and prune/archive would run
      const attachedDir = await registerAttachedSibling();
      await registeredWorkspace(false);

      // When: force-closing the attached checkout
      await service.teardown({ workspaceId: 'inst-adfa', force: true });

      // Then: the shared store is still pruned via the provisioned sibling...
      expect(fs.existsSync(attachedDir)).toBe(false);
      expect(mockLore.repositoryInstancePrune).toHaveBeenCalledWith(
        { repositoryPath: workspaceDir },
        {}
      );
      // ...but NO branch is archived: the display name must never be used as
      // a branch name against the shared store (it could match a real branch)
      expect(mockLore.branchArchive).not.toHaveBeenCalled();
    });

    it('provisioned entries keep the existing behavior: no force required when clean', async () => {
      // Given: a clean, tracked PROVISIONED workspace with a sibling (existing
      // fixture) — the new attached/cloned confirmation guard must not apply
      await registeredWorkspace(true);

      // When: tearing down without force
      await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: it succeeds exactly as before (provisioned behavior unchanged)
      expect(fs.existsSync(workspaceDir)).toBe(false);
    });
  });

  describe('forget', () => {
    it('drops the registry entry but leaves the directory and branch untouched', async () => {
      // Given: a clean, tracked workspace
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);

      // When: forgetting it by id
      await service.forget({ workspaceId: 'inst-1' });

      // Then: the registry entry is gone, but the directory is untouched and
      // no destructive Lore call was made
      await expect(
        new WorkspaceRegistry(mockLog).findByLocalPath(workspaceDir)
      ).resolves.toBeUndefined();
      expect(fs.existsSync(workspaceDir)).toBe(true);
      expect(mockLore.repositoryInstancePrune).not.toHaveBeenCalled();
      expect(mockLore.branchArchive).not.toHaveBeenCalled();
    });

    it('resolves a workspace by path as well as by id', async () => {
      // Given: a clean, tracked workspace
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);

      // When: forgetting it by path
      await service.forget({ path: workspaceDir });

      // Then: it is untracked
      await expect(
        new WorkspaceRegistry(mockLog).findByLocalPath(workspaceDir)
      ).resolves.toBeUndefined();
      expect(fs.existsSync(workspaceDir)).toBe(true);
    });

    it('never guards on uncommitted or unpushed work (untrack-only, non-destructive)', async () => {
      // Given: a tracked workspace with dirty files and unpushed commits
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);
      loreRepositoryService.getFileStatus.mockResolvedValue({
        untracked: [],
        unstaged: [{ path: 'a.txt', isUntracked: false, isStaged: false, conflict: false }],
        staged: [],
      });
      loreRepositoryService.getWorkspaceRevisionStatus.mockResolvedValue({
        branchName: BRANCH,
        revision: 'b',
        divergence: { state: 'ahead', latest: 'b', latestRemote: 'a' },
      });

      // When/Then: forget still succeeds
      await expect(service.forget({ workspaceId: 'inst-1' })).resolves.toBeUndefined();
      await expect(
        new WorkspaceRegistry(mockLog).findByLocalPath(workspaceDir)
      ).resolves.toBeUndefined();
    });

    it('refuses to forget a path that is not a registered workspace', async () => {
      // When/Then: an untracked path is refused
      await expect(service.forget({ path: path.join(tmpBase, 'not-a-workspace') })).rejects.toThrow(
        /not found|not a tracked instance/i
      );
    });

    it('emits a lifecycle event on success', async () => {
      // Given: a clean, tracked workspace
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);
      const listener = jest.fn();
      service.on('lifecycle', listener);

      // When: forgetting it
      await service.forget({ workspaceId: 'inst-1' });

      // Then: a lifecycle event fires so the model refreshes immediately
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('forgets a non-anchor attached-origin sibling without touching its directory (amendment: Forget works regardless of origin)', async () => {
      // Given: an attached sibling of the anchor repo
      const siblingDir = path.join(tmpBase, 'adfa');
      fs.mkdirSync(siblingDir, { recursive: true });
      stores.register('adfa-store', {
        instanceId: 'inst-adfa',
        path: siblingDir,
        branchName: 'main',
      });
      const siblingId = randomUUID();
      await new WorkspaceRegistry(mockLog).upsertById(
        RepositorySchema.parse({
          id: siblingId,
          name: 'adfa',
          url: repo.url,
          localPath: siblingDir,
          accentHue: 74,
          origin: 'attached',
          createdAt: PROVISIONED_AT,
          updatedAt: PROVISIONED_AT,
        })
      );

      // When: forgetting it by its self-reported instance id
      await service.forget({ workspaceId: 'inst-adfa' });

      // Then: untracked, but the directory is left in place
      await expect(
        new WorkspaceRegistry(mockLog).findByLocalPath(siblingDir)
      ).resolves.toBeUndefined();
      expect(fs.existsSync(siblingDir)).toBe(true);
    });
  });

  describe('lifecycle events', () => {
    it('emits a lifecycle event on successful provision', async () => {
      // Given: a clone that joins a shared store self-reporting this workspace
      stores.register('shared', {
        instanceId: 'inst-1',
        path: workspaceDir,
        branchName: BRANCH,
        revision: 'r1',
      });
      const listener = jest.fn();
      service.on('lifecycle', listener);

      // When: provisioning succeeds
      await service.provision({ repositoryId: repo.id, branchName: BRANCH });

      // Then: a lifecycle event fires with the repository id and workspace path
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('emits a lifecycle event when an existing workspace is adopted', async () => {
      // Given: an orphaned workspace on disk that self-reports a matching branch
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', {
        instanceId: 'inst-orphan',
        path: workspaceDir,
        branchName: BRANCH,
        revision: 'r9',
      });
      const listener = jest.fn();
      service.on('lifecycle', listener);

      // When: provisioning adopts the existing directory
      await service.provision({ repositoryId: repo.id, branchName: BRANCH });

      // Then: the lifecycle event still fires
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not emit a lifecycle event when provision fails', async () => {
      // Given: the clone rejects mid-flight
      mockLore.repositoryClone.mockReturnValue(
        fluentMock({ error: loreError(10, 'server unreachable') }) as never
      );
      const listener = jest.fn();
      service.on('lifecycle', listener);

      // When: provisioning fails
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow(WorkspaceOperationError);

      // Then: no lifecycle event fires
      expect(listener).not.toHaveBeenCalled();
    });

    it('emits a lifecycle event on successful teardown', async () => {
      // Given: a clean, tracked workspace with a sibling in the shared store
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      const siblingDir = path.join(worktreeRoot, 'agent-y');
      fs.mkdirSync(siblingDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-2', path: siblingDir, branchName: 'agent-y' });
      await seedRegistry([
        { path: workspaceDir, branchName: BRANCH },
        { path: siblingDir, branchName: 'agent-y' },
      ]);
      const listener = jest.fn();
      service.on('lifecycle', listener);

      // When: tearing it down
      await service.teardown({ workspaceId: 'inst-1', force: false });

      // Then: a lifecycle event fires with the repository id and workspace path
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not emit a lifecycle event when teardown fails (uncommitted changes)', async () => {
      // Given: a tracked workspace with dirty files
      fs.mkdirSync(workspaceDir, { recursive: true });
      stores.register('shared', { instanceId: 'inst-1', path: workspaceDir, branchName: BRANCH });
      await seedRegistry([{ path: workspaceDir, branchName: BRANCH }]);
      loreRepositoryService.getFileStatus.mockResolvedValue({
        untracked: [],
        unstaged: [{ path: 'a.txt', isUntracked: false, isStaged: false, conflict: false }],
        staged: [],
      });
      const listener = jest.fn();
      service.on('lifecycle', listener);

      // When/Then: teardown is refused
      await expect(service.teardown({ workspaceId: 'inst-1', force: false })).rejects.toThrow(
        'uncommitted'
      );

      // Then: no lifecycle event fires
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('routes registry operations through an injected shared registry instance (C56)', async () => {
      // Given: a shared registry injected at construction (index.ts wires ONE
      // instance across RepositoryService and WorkspaceService so their
      // read-modify-write cycles serialize through the same queue)
      const shared = new WorkspaceRegistry(mockLog);
      const allSpy = jest.spyOn(shared, 'all');
      const injected = new WorkspaceService(
        mockLog,
        repositoryService,
        loreRepositoryService,
        undefined,
        shared
      );

      // When: listing workspaces
      await injected.list(repo.id);

      // Then: the injected instance served the read
      expect(allSpy).toHaveBeenCalled();
    });

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

    it('fails provisioning when the clone produced no self-reported instance', async () => {
      // Given: clone + branch succeed, but the workspace's own store lists nothing
      // (no shared-store member registered)

      // When/Then: provisioning fails clearly and nothing is persisted
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow('was not registered as an instance');
      await expect(new WorkspaceRegistry(mockLog).all()).resolves.toEqual([]);
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

    it('wraps a LoreError from the branch-create step with the operation context', async () => {
      // Given: clone succeeds but branch creation rejects with a LoreError
      mockLore.branchCreate.mockReturnValue(
        fluentMock({ error: loreError(7, 'branch exists') }) as never
      );

      // When/Then: the failure is wrapped with the operation context and cleaned up
      await expect(
        service.provision({ repositoryId: repo.id, branchName: BRANCH })
      ).rejects.toThrow(/Failed to create branch "agent-x": branch exists/);
      expect(fs.existsSync(workspaceDir)).toBe(false);
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
