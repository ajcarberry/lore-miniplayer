import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The store resolves its file from Electron's userData directory; point it at a
// per-test temp dir so tests run against the real filesystem (mirrors the
// repository store test).
const mockUserData = { dir: '' };
jest.mock('electron', () => ({
  app: {
    getPath: (): string => mockUserData.dir,
  },
}));

import { WorkspaceStore } from '../../../src/main/services/workspace-store';

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never;

const REPO_A = '3b2f6f2e-4f9b-4a57-9d5c-2f6f2e4f9b4a';
const REPO_B = '9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f';

function entry(overrides: Partial<Record<string, string>> = {}): {
  repositoryId: string;
  path: string;
  branchName: string;
  provisionedAt: string;
} {
  return {
    repositoryId: REPO_A,
    path: '/tmp/repo-wt/agent-x',
    branchName: 'agent-x',
    provisionedAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('WorkspaceStore', () => {
  let store: WorkspaceStore;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ws-store-test-'));
    store = new WorkspaceStore(mockLog);
  });

  afterEach(() => {
    fs.rmSync(mockUserData.dir, { recursive: true, force: true });
  });

  it('returns an empty registry before anything is written', async () => {
    // Given: a fresh store; When/Then: nothing is registered
    await expect(store.list()).resolves.toEqual([]);
  });

  it('persists an entry that survives a reload into a new store instance', async () => {
    // Given: an entry added to the registry
    await store.add(entry());

    // When: a brand-new store instance reads the same userData file
    const reloaded = new WorkspaceStore(mockLog);

    // Then: the entry is there
    await expect(reloaded.list()).resolves.toEqual([entry()]);
    expect(fs.existsSync(path.join(mockUserData.dir, 'workspaces.json'))).toBe(true);
  });

  it('upserts by resolved path instead of duplicating', async () => {
    // Given: an entry, then the same path re-added with a different branch
    await store.add(entry({ branchName: 'agent-x' }));
    await store.add(entry({ path: '/tmp/repo-wt/agent-x/', branchName: 'agent-x2' }));

    // Then: one entry remains, carrying the latest data
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.branchName).toBe('agent-x2');
  });

  it('filters entries by repository id', async () => {
    // Given: entries across two repositories
    await store.add(entry({ repositoryId: REPO_A, path: '/tmp/a-wt/x', branchName: 'x' }));
    await store.add(entry({ repositoryId: REPO_B, path: '/tmp/b-wt/y', branchName: 'y' }));

    // Then: listByRepository returns only the matching repo's entries
    const forA = await store.listByRepository(REPO_A);
    expect(forA.map(e => e.path)).toEqual(['/tmp/a-wt/x']);
  });

  it('finds an entry by resolved path', async () => {
    // Given: a registered entry
    await store.add(entry({ path: '/tmp/repo-wt/agent-x' }));

    // Then: it is found regardless of a trailing separator
    await expect(store.findByPath('/tmp/repo-wt/agent-x/')).resolves.toMatchObject({
      branchName: 'agent-x',
    });
    await expect(store.findByPath('/tmp/repo-wt/other')).resolves.toBeUndefined();
  });

  it('removes an entry by resolved path', async () => {
    // Given: two registered entries
    await store.add(entry({ path: '/tmp/repo-wt/x', branchName: 'x' }));
    await store.add(entry({ path: '/tmp/repo-wt/y', branchName: 'y' }));

    // When: one is removed (trailing separator still resolves)
    await store.remove('/tmp/repo-wt/x/');

    // Then: only the other survives, and the removal persists across reload
    const reloaded = new WorkspaceStore(mockLog);
    const entries = await reloaded.list();
    expect(entries.map(e => e.path)).toEqual(['/tmp/repo-wt/y']);
  });

  it('rejects a corrupt registry file rather than silently dropping data', async () => {
    // Given: a malformed workspaces.json on disk
    fs.writeFileSync(path.join(mockUserData.dir, 'workspaces.json'), '{ not json');

    // When/Then: reads surface the error (never a silent empty registry)
    await expect(store.list()).rejects.toThrow(/Failed to load workspaces/);
    expect((mockLog as unknown as { error: jest.Mock }).error).toHaveBeenCalled();
  });
});
