import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// The concurrency test needs to hold the registry's save mid-write, and
// fs/promises exports are non-configurable (jest.spyOn cannot patch them), so
// writeFile is wrapped in a pass-through jest.fn the test can intercept once.
// Every other call falls through to the real filesystem.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, writeFile: jest.fn(actual.writeFile) };
});

// The registry resolves its file from Electron's userData directory; point it
// at a per-test temp dir so tests run against the real filesystem.
const mockUserData = { dir: '' };
jest.mock('electron', () => ({
  app: {
    getPath: (): string => mockUserData.dir,
  },
}));

import { WorkspaceRegistry, sameLoreRepo } from '../../../src/main/services/workspace-store';
import { RepositorySchema } from '../../../src/shared/schemas';
import type { Repository } from '../../../src/shared/types';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never;

const REPO_A = '3b2f6f2e-4f9b-4a57-9d5c-2f6f2e4f9b4a';
const REPO_B = '9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

function storePath(name: string): string {
  return path.join(mockUserData.dir, name);
}

function repo(overrides: Partial<Repository> = {}): Repository {
  return RepositorySchema.parse({
    id: REPO_A,
    name: 'First',
    url: 'lore.example.com/First',
    localPath: '/tmp/repos/first',
    accentHue: 74,
    origin: 'attached',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  });
}

describe('WorkspaceRegistry', () => {
  let registry: WorkspaceRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ws-registry-test-'));
    registry = new WorkspaceRegistry(mockLog);
  });

  afterEach(() => {
    fs.rmSync(mockUserData.dir, { recursive: true, force: true });
  });

  describe('basic persistence', () => {
    it('returns an empty registry on first read and writes a v2 file on first save', async () => {
      // Given: a fresh store; When/Then: nothing is registered
      await expect(registry.all()).resolves.toEqual([]);

      // When: the first entry is written
      await registry.upsertById(repo());

      // Then: a v2 file is written
      const raw = JSON.parse(fs.readFileSync(storePath('workspaces.json'), 'utf-8')) as {
        version: string;
        workspaces: unknown[];
      };
      expect(raw.version).toBe('2.0.0');
      expect(raw.workspaces).toHaveLength(1);
    });

    it('upserts by id and survives a reload into a new instance', async () => {
      // Given: an entry added by id
      await registry.upsertById(repo());

      // When: a brand-new instance reads the same file
      const reloaded = new WorkspaceRegistry(mockLog);

      // Then: the entry is there and findById resolves it
      await expect(reloaded.all()).resolves.toEqual([repo()]);
      await expect(reloaded.findById(REPO_A)).resolves.toEqual(repo());
    });

    it('replaces an entry with the same id instead of duplicating', async () => {
      // Given: an entry, then the same id re-added with a new name
      await registry.upsertById(repo());
      await registry.upsertById(repo({ name: 'Renamed' }));

      // Then: one entry remains carrying the latest data
      const all = await registry.all();
      expect(all).toHaveLength(1);
      expect(all[0]?.name).toBe('Renamed');
    });

    it('upserts by resolved localPath instead of duplicating', async () => {
      // Given: a provisioned entry, then the same path re-added (trailing sep)
      const provisioned = repo({
        id: REPO_B,
        name: 'agent-x',
        localPath: '/tmp/first-wt/agent-x',
        origin: 'provisioned',
        branchName: 'agent-x',
      });
      await registry.upsertByLocalPath(provisioned);
      await registry.upsertByLocalPath({ ...provisioned, localPath: '/tmp/first-wt/agent-x/' });

      // Then: one entry remains
      const all = await registry.all();
      expect(all).toHaveLength(1);
    });

    it('finds entries sharing a url and by resolved localPath', async () => {
      // Given: two entries with the same url and one with another
      await registry.upsertById(repo());
      await registry.upsertById(
        repo({ id: REPO_B, name: 'agent-x', localPath: '/tmp/first-wt/agent-x', origin: 'cloned' })
      );

      // Then: byUrl returns both, byLocalPath resolves through a trailing sep
      await expect(registry.findByUrl('lore.example.com/First')).resolves.toHaveLength(2);
      await expect(registry.findByLocalPath('/tmp/repos/first/')).resolves.toMatchObject({
        id: REPO_A,
      });
    });

    it('removes by id and by localPath', async () => {
      // Given: two entries
      await registry.upsertById(repo());
      await registry.upsertById(repo({ id: REPO_B, localPath: '/tmp/repos/second' }));

      // When: removing one by id and confirming removeById reports the result
      await expect(registry.removeById(REPO_A)).resolves.toBe(true);
      await expect(registry.removeById('unknown')).resolves.toBe(false);

      // And: removing the other by localPath (trailing sep still resolves)
      await registry.removeByLocalPath('/tmp/repos/second/');
      await expect(registry.all()).resolves.toEqual([]);
    });

    it('assigns accent hues round-robin by entry count', async () => {
      // Given: an empty store
      // Then: nextAccentHue cycles the four named accents as entries grow
      expect(await registry.nextAccentHue()).toBe(74);
      await registry.upsertById(repo({ id: REPO_A, localPath: '/tmp/a' }));
      expect(await registry.nextAccentHue()).toBe(172);
      await registry.upsertById(repo({ id: REPO_B, localPath: '/tmp/b' }));
      expect(await registry.nextAccentHue()).toBe(296);
    });

    it('rejects a corrupt registry file rather than silently dropping data', async () => {
      // Given: a malformed workspaces.json on disk
      fs.writeFileSync(storePath('workspaces.json'), '{ not json');

      // When/Then: reads surface the error (never a silent empty registry)
      await expect(registry.all()).rejects.toThrow(/Failed to load workspace registry/);
    });
  });

  describe('concurrency (C56)', () => {
    it('serializes overlapping read-modify-write cycles so neither update is lost', async () => {
      // Given: the registry's FIRST save is held mid-write, so a second
      // upsert can overlap the first's load-mutate-save cycle
      const realWriteFile =
        jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises').writeFile;
      let releaseFirstWrite!: () => void;
      const firstWriteHeld = new Promise<void>(resolve => {
        releaseFirstWrite = resolve;
      });
      let signalFirstWriteStarted!: () => void;
      const firstWriteStarted = new Promise<void>(resolve => {
        signalFirstWriteStarted = resolve;
      });
      (fsp.writeFile as jest.MockedFunction<typeof fsp.writeFile>).mockImplementationOnce(
        async (...args: Parameters<typeof fsp.writeFile>) => {
          signalFirstWriteStarted();
          await firstWriteHeld;
          return realWriteFile(...args);
        }
      );

      // When: a second upsert runs while the first's save is still in flight
      const first = registry.upsertById(repo({ id: REPO_A, localPath: '/tmp/repos/first' }));
      const overlap = (async (): Promise<void> => {
        await firstWriteStarted;
        await registry.upsertById(
          repo({ id: REPO_B, name: 'Second', localPath: '/tmp/repos/second' })
        );
      })();
      // Give an unserialized implementation every chance to complete the
      // second cycle before the first write lands (the lost-update window)
      const raced = await Promise.race([
        overlap.then(() => 'overlap-finished'),
        new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 50)),
      ]);
      releaseFirstWrite();
      await Promise.all([first, overlap]);

      // Then: the second cycle was queued behind the first (never interleaved)
      expect(raced).toBe('held');
      // And: BOTH entries survive on disk — no lost update
      const reloaded = await new WorkspaceRegistry(mockLog).all();
      expect(reloaded.map(entry => entry.id).sort()).toEqual([REPO_A, REPO_B].sort());
    });
  });

  describe('migration to v2', () => {
    const legacyRepoFile = {
      version: '1.0.0',
      repositories: [
        {
          id: REPO_A,
          name: 'First',
          url: 'lore.example.com/First',
          localPath: '/tmp/repos/first',
          accentHue: 74,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    it('migrates the legacy repositories.json and backs it up', async () => {
      // Given: only the legacy repository file
      fs.writeFileSync(storePath('repositories.json'), JSON.stringify(legacyRepoFile));

      // When: loading
      const all = await registry.all();

      // Then: the repo is migrated to origin 'attached' and the file backed up
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: REPO_A, origin: 'attached' });
      expect(fs.existsSync(storePath('repositories.json'))).toBe(false);
      expect(fs.existsSync(storePath('repositories.json.bak'))).toBe(true);
      const v2 = JSON.parse(fs.readFileSync(storePath('workspaces.json'), 'utf-8')) as {
        version: string;
      };
      expect(v2.version).toBe('2.0.0');
    });

    it('does nothing when no legacy file exists (fresh install)', async () => {
      // When: loading a fresh profile
      const all = await registry.all();

      // Then: an empty registry, no backups created
      expect(all).toEqual([]);
      expect(fs.existsSync(storePath('repositories.json.bak'))).toBe(false);
    });

    it('is idempotent across reruns, preserving the backup', async () => {
      // Given: a first migration
      fs.writeFileSync(storePath('repositories.json'), JSON.stringify(legacyRepoFile));
      const first = await registry.all();

      // When: a fresh instance re-reads (simulating an app restart)
      const rerun = await new WorkspaceRegistry(mockLog).all();

      // Then: the result is unchanged and no re-migration occurs
      expect(rerun).toEqual(first);
      expect(fs.existsSync(storePath('repositories.json'))).toBe(false);
      expect(fs.existsSync(storePath('repositories.json.bak'))).toBe(true);
    });

    it('folds a lingering repositories.json into an existing v2 store', async () => {
      // Given: an already-v2 workspaces.json plus a legacy repositories.json
      await registry.upsertById(
        repo({
          id: REPO_B,
          name: 'Second',
          url: 'lore.example.com/Second',
          localPath: '/tmp/second',
        })
      );
      fs.writeFileSync(storePath('repositories.json'), JSON.stringify(legacyRepoFile));

      // When: a new instance loads
      const all = await new WorkspaceRegistry(mockLog).all();

      // Then: both entries coexist and the v2 file is kept (only repos backed up)
      expect(all.map(e => e.id).sort()).toEqual([REPO_A, REPO_B].sort());
      expect(fs.existsSync(storePath('workspaces.json.bak'))).toBe(false);
      expect(fs.existsSync(storePath('repositories.json.bak'))).toBe(true);
    });
  });
});

describe('sameLoreRepo', () => {
  it('matches on loreRepositoryId when both sides carry one, ignoring url', () => {
    // Given: two entries with different urls but the same stable Lore id
    expect(
      sameLoreRepo(
        { url: 'lore://a/x', loreRepositoryId: 'id-1' },
        { url: 'lore://b/y', loreRepositoryId: 'id-1' }
      )
    ).toBe(true);
  });

  it('rejects a match when both ids are present but differ (id beats url)', () => {
    // Given: two entries sharing a url but reporting different Lore ids
    expect(
      sameLoreRepo(
        { url: 'lore://a/x', loreRepositoryId: 'id-1' },
        { url: 'lore://a/x', loreRepositoryId: 'id-2' }
      )
    ).toBe(false);
  });

  it('falls back to url equality when either side lacks an id', () => {
    // Given: one side has no id — grouping degrades to url
    expect(
      sameLoreRepo({ url: 'lore://a/x', loreRepositoryId: 'id-1' }, { url: 'lore://a/x' })
    ).toBe(true);
    expect(sameLoreRepo({ url: 'lore://a/x' }, { url: 'lore://b/y' })).toBe(false);
  });
});
