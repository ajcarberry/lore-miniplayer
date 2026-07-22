import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The service resolves its store path from Electron's userData directory;
// point it at a per-test temp dir so tests run against the real filesystem
const mockUserData = { dir: '' };
jest.mock('electron', () => ({
  app: {
    getPath: (): string => mockUserData.dir,
  },
}));

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    initialize: jest.fn(),
  },
}));

import log from 'electron-log/main.js';
import {
  RepositoryService,
  type RepositoryIdentityResolver,
} from '../../../src/main/services/repository';
import { WorkspaceRegistry } from '../../../src/main/services/workspace-store';
import { RepositorySchema } from '../../../src/shared/schemas';

const createInput = {
  name: 'My Repo',
  url: 'lore.example.com/MyRepo',
  localPath: '/tmp/repos/my-repo',
};

// The url the attach-existing-folder flow records before its true Lore
// identity is resolved (see useRepositorySubmission.ts / repository.ts).
const PLACEHOLDER_URL = 'local://existing';

// A stand-in for LoreRepositoryService.resolveRepositoryIdentity whose result
// (or failure) each test controls; the call is a jest.fn so counts assert
// idempotency.
function fakeResolver(
  impl: (localPath: string) => Promise<{ url: string; loreRepositoryId?: string } | undefined>
): RepositoryIdentityResolver & { resolveRepositoryIdentity: jest.Mock } {
  return { resolveRepositoryIdentity: jest.fn(impl) };
}

// Seed an attached entry still carrying the placeholder url, as the pre-fix
// attach flow would have persisted it.
async function seedPlaceholderAttached(localPath: string): Promise<string> {
  const id = '9f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5aaa';
  await new WorkspaceRegistry(log as never).upsertById(
    RepositorySchema.parse({
      id,
      name: 'adfa',
      url: PLACEHOLDER_URL,
      localPath,
      accentHue: 74,
      origin: 'attached',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
  );
  return id;
}

// Seed an attached entry with a truthful (non-placeholder) url but NO resolved
// loreRepositoryId — the shape a real remote attach leaves before the id seam
// existed. `id backfill on load` must resolve and stamp its id.
async function seedIdlessAttached(id: string, localPath: string, url: string): Promise<void> {
  await new WorkspaceRegistry(log as never).upsertById(
    RepositorySchema.parse({
      id,
      name: 'demo-project',
      url,
      localPath,
      accentHue: 74,
      origin: 'attached',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
  );
}

// A provisioned worktree seeded straight into the unified registry (as
// WorkspaceService.provision would), to prove RepositoryService excludes it
// from the card-view getAll but still forgets it via delete.
async function seedProvisioned(id: string, localPath: string): Promise<void> {
  await new WorkspaceRegistry(log as never).upsertByLocalPath(
    RepositorySchema.parse({
      id,
      name: 'agent-x',
      url: 'lore.example.com/MyRepo',
      localPath,
      accentHue: 74,
      origin: 'provisioned',
      branchName: 'agent-x',
      provisionedAt: '2026-07-22T00:00:00.000Z',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    })
  );
}

describe('RepositoryService', () => {
  let service: RepositoryService;

  beforeEach(async () => {
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-miniplayer-test-'));
    service = new RepositoryService(log);
    await service.initialize();
  });

  afterEach(() => {
    fs.rmSync(mockUserData.dir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should create an empty store file on first run', async () => {
      // Then: the unified registry file exists and holds no repositories
      const storePath = path.join(mockUserData.dir, 'workspaces.json');
      expect(fs.existsSync(storePath)).toBe(true);
      await expect(service.getAll()).resolves.toEqual([]);
    });
  });

  describe('create', () => {
    it('should persist a new repository to disk', async () => {
      // When: creating a repository
      const created = await service.create(createInput);

      // Then: it gets an id and timestamps and survives a reload from disk
      expect(created).toMatchObject(createInput);
      expect(created.id).toMatch(/[0-9a-f-]{36}/);
      expect(created.createdAt).toBe(created.updatedAt);

      const reloaded = new RepositoryService(log);
      await reloaded.initialize();
      await expect(reloaded.getAll()).resolves.toEqual([created]);
    });

    it('should reject a duplicate name regardless of case', async () => {
      // Given: an existing repository
      await service.create(createInput);

      // When: creating another with the same name in different case
      const promise = service.create({
        ...createInput,
        name: 'my repo',
        localPath: '/tmp/repos/other',
      });

      // Then: creation is rejected
      await expect(promise).rejects.toThrow('already exists');
    });

    it('should reject a duplicate local path', async () => {
      // Given: an existing repository
      await service.create(createInput);

      // When: creating another pointed at the same path
      const promise = service.create({ ...createInput, name: 'Other Name' });

      // Then: creation is rejected
      await expect(promise).rejects.toThrow('already configured for path');
    });

    it('should reject invalid input via schema validation', async () => {
      // When: creating with a relative local path
      const promise = service.create({ ...createInput, localPath: 'relative/path' });

      // Then: Zod validation rejects it
      await expect(promise).rejects.toThrow();
    });
  });

  describe('getById', () => {
    it('should return the repository or null', async () => {
      // Given: one repository
      const created = await service.create(createInput);

      // Then: lookup by id finds it and unknown ids return null
      await expect(service.getById(created.id)).resolves.toEqual(created);
      await expect(service.getById('4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b')).resolves.toBeNull();
    });
  });

  describe('update', () => {
    it('should update fields and bump updatedAt', async () => {
      // Given: an existing repository
      const created = await service.create(createInput);

      // When: renaming it
      const updated = await service.update({ id: created.id, name: 'Renamed' });

      // Then: the name changes, other fields persist, updatedAt is refreshed
      expect(updated.name).toBe('Renamed');
      expect(updated.url).toBe(created.url);
      expect(updated.createdAt).toBe(created.createdAt);
      expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));
    });

    it('should reject renaming to another repository name', async () => {
      // Given: two repositories sharing the same Lore url (name uniqueness is
      // per-url now)
      await service.create(createInput);
      const second = await service.create({
        name: 'Second',
        url: createInput.url,
        localPath: '/tmp/repos/second',
      });

      // When: renaming the second to collide with the first
      const promise = service.update({ id: second.id, name: 'My Repo' });

      // Then: the update is rejected
      await expect(promise).rejects.toThrow('already exists');
    });

    it('should reject updates to unknown repositories', async () => {
      // When: updating an id that does not exist
      const promise = service.update({
        id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
        name: 'Ghost',
      });

      // Then: the update is rejected
      await expect(promise).rejects.toThrow('not found');
    });
  });

  describe('delete', () => {
    it('should remove the repository from the persisted store', async () => {
      // Given: one repository
      const created = await service.create(createInput);

      // When: deleting it
      await service.delete(created.id);

      // Then: the store is empty, also after reloading from disk
      const reloaded = new RepositoryService(log);
      await reloaded.initialize();
      await expect(reloaded.getAll()).resolves.toEqual([]);
    });

    it('should reject deleting unknown repositories', async () => {
      // When: deleting an id that does not exist
      const promise = service.delete('unknown-id');

      // Then: the delete is rejected
      await expect(promise).rejects.toThrow('not found');
    });
  });

  describe('unified registry (packet U1)', () => {
    it('records origin "attached" by default and "cloned" when requested', async () => {
      // When: creating via the default path and via the clone path
      const attached = await service.create(createInput);
      const cloned = await service.create(
        { ...createInput, name: 'Cloned', localPath: '/tmp/repos/cloned' },
        'cloned'
      );

      // Then: each entry records how it came to exist
      expect(attached.origin).toBe('attached');
      expect(cloned.origin).toBe('cloned');
    });

    it('allows the same name across different urls (name uniqueness is per-url)', async () => {
      // Given: a repository named "My Repo" at one url
      await service.create(createInput);

      // When: creating another "My Repo" at a DIFFERENT url
      const other = service.create({
        ...createInput,
        url: 'lore.example.com/Other',
        localPath: '/tmp/repos/other',
      });

      // Then: it is allowed (branch/worktree names repeat across repos)
      await expect(other).resolves.toMatchObject({ name: 'My Repo' });
    });

    it('still rejects a duplicate localPath across all origins', async () => {
      // Given: a provisioned worktree occupying a path
      await service.create(createInput);
      await seedProvisioned('11111111-1111-4111-8111-111111111111', '/tmp/wt/agent-x');

      // When: creating a card-view repo at that same path
      const clash = service.create({
        ...createInput,
        name: 'Clash',
        localPath: '/tmp/wt/agent-x',
      });

      // Then: the localPath collision is rejected regardless of origin
      await expect(clash).rejects.toThrow('already configured for path');
    });

    it('getAll surfaces card-view origins but hides provisioned worktrees', async () => {
      // Given: a card-view repo and a provisioned worktree in the same registry
      const attached = await service.create(createInput);
      await seedProvisioned('22222222-2222-4222-8222-222222222222', '/tmp/wt/agent-x');

      // Then: only the card-view entry is listed
      const all = await service.getAll();
      expect(all.map(r => r.id)).toEqual([attached.id]);
    });

    it('getAll(true) surfaces every origin, including provisioned worktrees', async () => {
      // Given: a card-view repo and a provisioned worktree in the same registry
      const attached = await service.create(createInput);
      const provisionedId = '44444444-4444-4444-8444-444444444444';
      await seedProvisioned(provisionedId, '/tmp/wt/agent-y');

      // When: requesting every origin
      const all = await service.getAll(true);

      // Then: both the card-view entry and the provisioned worktree are listed
      expect(all.map(r => r.id).sort()).toEqual([attached.id, provisionedId].sort());
    });

    it('delete forgets any origin, including a provisioned worktree', async () => {
      // Given: a provisioned worktree tracked in the registry
      const provisionedId = '33333333-3333-4333-8333-333333333333';
      await seedProvisioned(provisionedId, '/tmp/wt/agent-x');

      // When: forgetting it by id (untrack-only)
      await service.delete(provisionedId);

      // Then: it is gone from the registry (and getById no longer resolves it)
      await expect(service.getById(provisionedId)).resolves.toBeNull();
    });
  });

  describe('attach identity resolution (placeholder url)', () => {
    const attachInput = {
      name: 'adfa',
      url: PLACEHOLDER_URL,
      localPath: '/Users/alex/Lore_Test/demo-project-wt/adfa',
    };

    it('resolves the true url and stamps loreRepositoryId on attach', async () => {
      // Given: a checkout that self-reports its real Lore identity
      const resolver = fakeResolver(async () => ({
        url: 'lore://127.0.0.1/demo-project',
        loreRepositoryId: '019f6e08-1234-4abc-8def-0123456789ab',
      }));
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // When: attaching an existing folder (placeholder url from the renderer)
      const created = await svc.create(attachInput);

      // Then: the entry records the true grouping url + stable id, not the
      // placeholder
      expect(resolver.resolveRepositoryIdentity).toHaveBeenCalledWith(attachInput.localPath);
      expect(created.url).toBe('lore://127.0.0.1/demo-project');
      expect(created.loreRepositoryId).toBe('019f6e08-1234-4abc-8def-0123456789ab');
      expect(created.origin).toBe('attached');
    });

    it('keeps the placeholder and leaves loreRepositoryId unset when offline', async () => {
      // Given: resolution fails (server unreachable / not a resolvable checkout)
      const resolver = fakeResolver(async () => {
        throw new Error('No auth endpoint available');
      });
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // When: attaching
      const created = await svc.create(attachInput);

      // Then: attach is not blocked; the truthful fallback keeps the placeholder
      // and stamps no id (heal retries on a later launch)
      expect(created.url).toBe(PLACEHOLDER_URL);
      expect(created.loreRepositoryId).toBeUndefined();
    });

    it('keeps the placeholder when the checkout reports no usable identity', async () => {
      // Given: resolution returns undefined (no usable url/name in the event)
      const resolver = fakeResolver(async () => undefined);
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // When: attaching
      const created = await svc.create(attachInput);

      // Then: the placeholder is retained
      expect(created.url).toBe(PLACEHOLDER_URL);
      expect(created.loreRepositoryId).toBeUndefined();
    });

    it('does not resolve when the url is already a real Lore url', async () => {
      // Given: a create with a genuine url (the clone flow)
      const resolver = fakeResolver(async () => ({ url: 'unused', loreRepositoryId: 'x' }));
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // When: creating with a non-placeholder url
      const created = await svc.create(createInput, 'cloned');

      // Then: the url is preserved and no resolution is attempted
      expect(resolver.resolveRepositoryIdentity).not.toHaveBeenCalled();
      expect(created.url).toBe(createInput.url);
    });
  });

  describe('placeholder heal on load', () => {
    it('heals a placeholder entry in place on initialize', async () => {
      // Given: a placeholder attach entry from the pre-fix flow
      const id = await seedPlaceholderAttached('/Users/alex/Lore_Test/demo-project-wt/adfa');
      const resolver = fakeResolver(async () => ({
        url: 'lore://127.0.0.1/demo-project',
        loreRepositoryId: '019f6e08-1234-4abc-8def-0123456789ab',
      }));

      // When: the service loads (heal runs after migration)
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // Then: the entry now carries its true identity, persisted to disk
      const healed = await svc.getById(id);
      expect(healed?.url).toBe('lore://127.0.0.1/demo-project');
      expect(healed?.loreRepositoryId).toBe('019f6e08-1234-4abc-8def-0123456789ab');

      const reloaded = new RepositoryService(log, resolver);
      await reloaded.initialize();
      expect((await reloaded.getById(id))?.url).toBe('lore://127.0.0.1/demo-project');
    });

    it('leaves a placeholder entry unchanged when resolution fails (non-fatal)', async () => {
      // Given: a placeholder entry and a resolver that throws
      const id = await seedPlaceholderAttached('/tmp/orphan');
      const resolver = fakeResolver(async () => {
        throw new Error('unreachable');
      });

      // When: initializing
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // Then: the entry is untouched (still a placeholder) — init did not throw
      const entry = await svc.getById(id);
      expect(entry?.url).toBe(PLACEHOLDER_URL);
      expect(entry?.loreRepositoryId).toBeUndefined();
    });

    it('is idempotent: a healed entry is not re-resolved on the next load', async () => {
      // Given: a placeholder entry healed on first load
      await seedPlaceholderAttached('/tmp/adfa');
      const resolver = fakeResolver(async () => ({
        url: 'lore://127.0.0.1/demo-project',
        loreRepositoryId: 'id-1',
      }));
      const first = new RepositoryService(log, resolver);
      await first.initialize();
      expect(resolver.resolveRepositoryIdentity).toHaveBeenCalledTimes(1);

      // When: a second service loads the already-healed store
      const second = new RepositoryService(log, resolver);
      await second.initialize();

      // Then: no further resolution is attempted (url no longer matches the
      // placeholder)
      expect(resolver.resolveRepositoryIdentity).toHaveBeenCalledTimes(1);
    });
  });

  describe('id backfill on load (all origins)', () => {
    const REAL_URL = 'lore://127.0.0.1/demo-project';

    it('backfills loreRepositoryId for a truthful-url entry that lacks one', async () => {
      // Given: an attached entry with a real url but no resolved id (pre-seam)
      const id = 'a1111111-1111-4111-8111-111111111111';
      await seedIdlessAttached(id, '/tmp/demo', REAL_URL);
      const resolver = fakeResolver(async () => ({
        url: REAL_URL,
        loreRepositoryId: 'repo-backfilled',
      }));

      // When: the service loads (heal runs after migration)
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // Then: the id is stamped in place; the already-truthful url is kept
      const entry = await svc.getById(id);
      expect(entry?.loreRepositoryId).toBe('repo-backfilled');
      expect(entry?.url).toBe(REAL_URL);
      expect(resolver.resolveRepositoryIdentity).toHaveBeenCalledWith('/tmp/demo');
    });

    it('leaves the entry unchanged when resolution fails (non-fatal per entry)', async () => {
      // Given: an idless entry and a resolver that throws
      const id = 'a2222222-2222-4222-8222-222222222222';
      await seedIdlessAttached(id, '/tmp/orphan', REAL_URL);
      const resolver = fakeResolver(async () => {
        throw new Error('unreachable');
      });

      // When: initializing
      const svc = new RepositoryService(log, resolver);
      await svc.initialize();

      // Then: still no id, url intact, init did not throw
      const entry = await svc.getById(id);
      expect(entry?.loreRepositoryId).toBeUndefined();
      expect(entry?.url).toBe(REAL_URL);
    });

    it('is idempotent: an entry that already has an id is not re-resolved', async () => {
      // Given: an idless entry backfilled on first load
      await seedIdlessAttached('a3333333-3333-4333-8333-333333333333', '/tmp/stable', REAL_URL);
      const resolver = fakeResolver(async () => ({
        url: REAL_URL,
        loreRepositoryId: 'repo-1',
      }));
      const first = new RepositoryService(log, resolver);
      await first.initialize();
      expect(resolver.resolveRepositoryIdentity).toHaveBeenCalledTimes(1);

      // When: a second service loads the already-backfilled store
      const second = new RepositoryService(log, resolver);
      await second.initialize();

      // Then: no further resolution (the id is already present)
      expect(resolver.resolveRepositoryIdentity).toHaveBeenCalledTimes(1);
    });
  });

  describe('accentHue', () => {
    it('should auto-assign accent hues round-robin on create', async () => {
      // When: creating five repositories in sequence
      const created = [];
      for (const name of ['A', 'B', 'C', 'D', 'E']) {
        created.push(
          await service.create({ ...createInput, name, localPath: `/tmp/repos/${name}` })
        );
      }

      // Then: the accent hues cycle through the four named accents
      expect(created.map(repo => repo.accentHue)).toEqual([74, 172, 296, 38, 74]);
    });

    it('should update the accent hue via the update path', async () => {
      // Given: an existing repository
      const created = await service.create(createInput);

      // When: changing its accent hue
      const updated = await service.update({ id: created.id, accentHue: 172 });

      // Then: the accent hue changes, other fields persist
      expect(updated.accentHue).toBe(172);
      expect(updated.name).toBe(created.name);
    });

    it('should reject an invalid accentHue on update', async () => {
      // Given: an existing repository
      const created = await service.create(createInput);

      // When: updating with a hue outside the defined set
      const promise = service.update({ id: created.id, accentHue: 999 });

      // Then: the update is rejected
      await expect(promise).rejects.toThrow();
    });

    it('should back-fill missing accentHue on legacy stores and persist it', async () => {
      // Given: a store file written before accentHue existed
      const storePath = path.join(mockUserData.dir, 'repositories.json');
      const legacyStore = {
        version: '1.0.0',
        repositories: [
          {
            id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
            name: 'First',
            url: 'lore.example.com/First',
            localPath: '/tmp/repos/first',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: '5f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6c',
            name: 'Second',
            url: 'lore.example.com/Second',
            localPath: '/tmp/repos/second',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      fs.writeFileSync(storePath, JSON.stringify(legacyStore));

      // When: reading the store
      const repos = await service.getAll();

      // Then: accent hues are back-filled round-robin by list order
      expect(repos.map(repo => repo.accentHue)).toEqual([74, 172]);

      // And: the back-fill is persisted to disk, not just held in memory
      const reloaded = new RepositoryService(log);
      await reloaded.initialize();
      await expect(reloaded.getAll()).resolves.toEqual(repos);
    });
  });

  describe('corrupted store handling', () => {
    it('should surface a load error for a corrupted legacy store file', async () => {
      // Given: a legacy repositories.json with invalid content (a migration source)
      const storePath = path.join(mockUserData.dir, 'repositories.json');
      fs.writeFileSync(storePath, '{"repositories": "not-an-array"}');

      // When: reading from it
      const promise = service.getAll();

      // Then: the failure is reported rather than silently swallowed
      await expect(promise).rejects.toThrow('Failed to load workspace registry');
    });
  });
});
