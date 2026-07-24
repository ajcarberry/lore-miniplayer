// Reproduction: two ATTACHED registry entries of the SAME Lore repo (a primary
// checkout "demo-project" and a sibling worktree "adfa" that was attached, both
// healed to the same loreRepositoryId). Mission Control's snapshot for EITHER
// watched id must contain exactly two cards — one active anchor and one sibling
// — never surfacing the anchor's own checkout twice.
//
// Wires the REAL RepositoryService + WorkspaceService (over a real
// workspaces.json) into the real WorkspaceModelService, with the SDK instance
// registry and the model's Lore signal source faked per-path.

jest.mock('@lore-vcs/sdk', () => {
  class LoreError extends Error {
    loreErrors: undefined;
  }
  return {
    LoreError,
    lore: {
      repositoryInstanceList: jest.fn(),
    },
  };
});

const mockUserData = { dir: '' };
jest.mock('electron', () => ({
  app: { getPath: (): string => mockUserData.dir },
}));

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lore } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import { RepositoryService } from '../../../src/main/services/repository';
import { WorkspaceService } from '../../../src/main/services/workspace-service';
import { WorkspaceModelService } from '../../../src/main/services/workspace-model';
import { WorkspaceRegistry } from '../../../src/main/services/workspace-store';
import type { WorkspaceModelDeps } from '../../../src/main/services/workspace-model';
import type {
  LoreRepositoryService,
  WorkspaceRevisionStatus,
} from '../../../src/main/services/lore-repository';
import type { LoreFileStatusGroup, RevisionSummary } from '../../../src/shared/types';
import { RepositorySchema } from '../../../src/shared/schemas';

const mockLore = lore as jest.Mocked<typeof lore>;
const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never;

const LORE_ID = 'lore-repo-id-shared';
const DEMO_ID = '11111111-1111-4111-8111-111111111111';
const ADFA_ID = '22222222-2222-4222-8222-222222222222';

interface FluentChain {
  registeredCallback: ((event: unknown) => void) | undefined;
  callback: (cb: (event: unknown) => void) => FluentChain;
  waitAsync: () => Promise<number>;
}

function fluentInstanceList(
  instances: Array<{ instanceId: string; path: string; branch: string }>
): FluentChain {
  const chain: FluentChain = {
    registeredCallback: undefined,
    callback: jest.fn((cb: (event: unknown) => void): FluentChain => {
      chain.registeredCallback = cb;
      return chain;
    }),
    waitAsync: jest.fn(async (): Promise<number> => {
      for (const inst of instances) {
        chain.registeredCallback?.({
          tag: LoreEventTag.REPOSITORY_INSTANCE,
          data: {
            instanceId: inst.instanceId,
            path: inst.path,
            branchName: inst.branch,
            branch: 'branch-id',
            revision: 'rev',
            stale: false,
          },
          clone() {
            return this;
          },
        });
      }
      return 0;
    }),
  };
  return chain;
}

// Per-path Lore signals for the model's anchor + card composition.
class FakeModelLore extends EventEmitter {
  currentBranchByPath = new Map<string, string>();
  getFileStatus = jest.fn(async (): Promise<LoreFileStatusGroup> => ({
    untracked: [],
    unstaged: [],
    staged: [],
  }));
  // One status call resolves branch + revision + divergence (C25/C27).
  getWorkspaceRevisionStatus = jest.fn(
    async (repositoryPath: string): Promise<WorkspaceRevisionStatus> => ({
      branchName: this.currentBranchByPath.get(path.resolve(repositoryPath)) ?? 'main',
      revision: 'rev-anchor',
      divergence: { state: 'inSync', latest: 'a', latestRemote: 'a' },
    })
  );
  getSessionCommits = jest.fn(async (): Promise<RevisionSummary[]> => []);
}

async function seedTwoAttached(demoPath: string, adfaPath: string): Promise<void> {
  const store = new WorkspaceRegistry(mockLog);
  const now = '2026-07-22T00:00:00.000Z';
  await store.upsertById(
    RepositorySchema.parse({
      id: DEMO_ID,
      name: 'demo-project',
      url: 'lore://127.0.0.1/demo-project',
      loreRepositoryId: LORE_ID,
      localPath: demoPath,
      accentHue: 74,
      origin: 'attached',
      createdAt: now,
      updatedAt: now,
    })
  );
  await store.upsertById(
    RepositorySchema.parse({
      id: ADFA_ID,
      name: 'adfa',
      url: 'lore://127.0.0.1/demo-project',
      loreRepositoryId: LORE_ID,
      localPath: adfaPath,
      accentHue: 172,
      origin: 'attached',
      createdAt: now,
      updatedAt: now,
    })
  );
}

describe('WorkspaceModel with two attached siblings of one Lore repo', () => {
  let tmpBase: string;
  let demoPath: string;
  let adfaPath: string;
  let model: WorkspaceModelService;
  let modelLore: FakeModelLore;

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-two-attached-'));
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-two-attached-ud-'));
    demoPath = path.join(tmpBase, 'demo-project');
    adfaPath = path.join(tmpBase, 'demo-project-wt', 'adfa');
    fs.mkdirSync(demoPath, { recursive: true });
    fs.mkdirSync(adfaPath, { recursive: true });

    await seedTwoAttached(demoPath, adfaPath);

    // Both checkouts share ONE Lore store; each path self-reports its own
    // instance (a shared store lists every member).
    const shared = [
      { instanceId: 'inst-demo', path: path.resolve(demoPath), branch: 'main' },
      { instanceId: 'inst-adfa', path: path.resolve(adfaPath), branch: 'adfa' },
    ];
    mockLore.repositoryInstanceList.mockImplementation(() => fluentInstanceList(shared) as never);

    const loreRepositoryService = {
      switchBranch: jest.fn(async () => undefined),
      getFileStatus: jest.fn(async () => ({ untracked: [], unstaged: [], staged: [] })),
      getBranchDivergence: jest.fn(async () => ({
        state: 'inSync',
        latest: 'a',
        latestRemote: 'a',
      })),
      // Identity already stamped; heal is a no-op.
      resolveRepositoryIdentity: jest.fn(async () => ({
        url: 'lore://127.0.0.1/demo-project',
        loreRepositoryId: LORE_ID,
      })),
    } as unknown as jest.Mocked<LoreRepositoryService>;

    const repositoryService = new RepositoryService(mockLog, loreRepositoryService);
    await repositoryService.initialize();
    const workspaceService = new WorkspaceService(
      mockLog,
      repositoryService,
      loreRepositoryService
    );

    modelLore = new FakeModelLore();
    modelLore.currentBranchByPath.set(path.resolve(demoPath), 'main');
    modelLore.currentBranchByPath.set(path.resolve(adfaPath), 'adfa');

    const deps: WorkspaceModelDeps = {
      workspaces: workspaceService,
      observer: Object.assign(new EventEmitter(), {
        listSessions: () => [],
      }) as unknown as WorkspaceModelDeps['observer'],
      transcript: { extract: jest.fn(async () => ({ tasks: [], commentary: [] })) },
      lore: modelLore as unknown as WorkspaceModelDeps['lore'],
      diff: { workspaceDirtyStats: jest.fn(async () => []) },
      repository: repositoryService,
    };
    model = new WorkspaceModelService(mockLog, deps);
  });

  it('watching the demo-project id yields exactly two cards (anchor + adfa sibling)', async () => {
    const snapshot = await model.snapshot(DEMO_ID);
    expect(snapshot.cards).toHaveLength(2);
    const active = snapshot.cards.filter(c => c.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]?.workspace.path).toBe(path.resolve(demoPath));
  });

  it('carries each sibling registry name onto its card (Mission Control disambiguation)', async () => {
    // Given: the anchor ("demo-project") and its sibling ("adfa") are both
    // attached registry entries — their cards must each carry the entry's OWN
    // registry name, not just the (possibly colliding) branch.
    const snapshot = await model.snapshot(DEMO_ID);

    const anchorCard = snapshot.cards.find(c => c.isActive);
    const siblingCard = snapshot.cards.find(c => !c.isActive);

    expect(anchorCard?.workspace.name).toBe('demo-project');
    expect(siblingCard?.workspace.name).toBe('adfa');
  });

  it('watching the adfa id yields exactly two cards (anchor + demo sibling)', async () => {
    const snapshot = await model.snapshot(ADFA_ID);
    expect(snapshot.cards).toHaveLength(2);
    const active = snapshot.cards.filter(c => c.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]?.workspace.path).toBe(path.resolve(adfaPath));
  });

  it('never surfaces the anchor checkout twice when a second record resolves to it', async () => {
    // Given: a second same-repo registry record (different id) whose localPath
    // is the SAME demo checkout as the watched anchor — the field shape left by
    // migration/heal. list(DEMO) excludes DEMO by id but still surfaces this
    // sibling, whose resolved path equals the anchor's, so the anchor's checkout
    // would otherwise appear twice (a plain idle "main" member AND the active
    // "main" anchor) alongside adfa — the reported 3-card symptom.
    const store = new WorkspaceRegistry(mockLog);
    await store.upsertById(
      RepositorySchema.parse({
        id: '33333333-3333-4333-8333-333333333333',
        name: 'demo-project-dup',
        url: 'lore://127.0.0.1/demo-project',
        loreRepositoryId: LORE_ID,
        localPath: demoPath,
        accentHue: 296,
        origin: 'attached',
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      })
    );

    // When: composing the snapshot for the demo (anchor) id
    const snapshot = await model.snapshot(DEMO_ID);

    // Then: the anchor's checkout is represented exactly once (as the anchor),
    // so the repo shows adfa + the active anchor — never a duplicate "main".
    const demoCards = snapshot.cards.filter(c => c.workspace.path === path.resolve(demoPath));
    expect(demoCards).toHaveLength(1);
    expect(demoCards[0]?.isActive).toBe(true);
    expect(snapshot.cards).toHaveLength(2);
  });
});
