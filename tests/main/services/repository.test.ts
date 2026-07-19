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
  default: { error: jest.fn(), initialize: jest.fn() },
}));

import log from 'electron-log/main.js';
import { RepositoryService } from '../../../src/main/services/repository';

const createInput = {
  name: 'My Repo',
  url: 'lore.example.com/MyRepo',
  localPath: '/tmp/repos/my-repo',
};

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
      // Then: the store file exists and holds no repositories
      const storePath = path.join(mockUserData.dir, 'repositories.json');
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
      // Given: two repositories
      await service.create(createInput);
      const second = await service.create({
        name: 'Second',
        url: 'lore.example.com/Second',
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
    it('should surface a load error for a corrupted store file', async () => {
      // Given: a store file with invalid content
      const storePath = path.join(mockUserData.dir, 'repositories.json');
      fs.writeFileSync(storePath, '{"repositories": "not-an-array"}');

      // When: reading from it
      const promise = service.getAll();

      // Then: the failure is reported rather than silently swallowed
      await expect(promise).rejects.toThrow('Failed to load repositories');
    });
  });
});
