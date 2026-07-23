/**
 * @jest-environment node
 */
// B2 regression: WorkspaceModelService.snapshot() must reflect an EXTERNAL
// process's branch switch and new commit on the very next call, with NO
// repositoryRelease/flush. Exercises the REAL Lore SDK (native FFI) + REAL
// LoreRepositoryService + REAL DiffService against a real offline scratch repo
// mutated by a separate `node` process — the actual production read path the
// Mission Control refresh drives in the electron MAIN process (a node runtime).
//
// This guards the finding that the "cross-process SDK store caching" hypothesis
// is FALSE (P1 finding f): the SDK reads live from the on-disk store every call,
// across processes, so the refresh path must NOT invalidate caches (a no-op that
// only adds latency). The node jest-environment is REQUIRED — under jsdom the
// native FFI event callbacks are not delivered and every read returns empty.
const mockUserData = { dir: '' };
jest.mock('electron', () => ({
  app: { getPath: (): string => mockUserData.dir },
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lore } from '@lore-vcs/sdk';
import { LoreRepositoryService } from '../../../src/main/services/lore-repository';
import { DiffService } from '../../../src/main/services/diff-service';
import { WorkspaceModelService } from '../../../src/main/services/workspace-model';
import type { WorkspaceModelDeps } from '../../../src/main/services/workspace-model';
import type { MainLogger } from '../../../src/main/ipc/logger';
import type { Repository } from '../../../src/shared/types';

const noopLog = {
  error: (): void => {},
  warn: (): void => {},
  info: (): void => {},
  debug: (): void => {},
} as unknown as MainLogger;

const REPO_ID = 'c97eabe1-3bc1-4333-be38-459c254f9a70';

// A fresh node process standing in for an external CLI / second app instance
// mutating the checkout. Run as an inline ES module so the bare `@lore-vcs/sdk`
// import resolves against the project node_modules (cwd) — no on-disk helper
// file to pollute the working tree.
const MUTATOR_SCRIPT = `import { lore } from '@lore-vcs/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
const repo = process.argv[1], mode = process.argv[2], arg = process.argv[3];
const gp = { repositoryPath: repo, offline: true, local: true };
process.chdir(repo);
const run = op => op.callback(()=>{}).waitAsync();
if (mode === 'commit') {
  fs.writeFileSync(path.join(repo, 'mut-' + Date.now() + '.txt'), 'external\\n');
  await run(lore.fileStage(gp, { paths: ['.'], scan: true }));
  await run(lore.revisionCommit(gp, { message: 'external commit' }));
} else {
  await run(lore.branchSwitch(gp, { branch: arg }));
}
lore.shutdown();`;

function runMutator(repo: string, mode: 'commit' | 'switch', arg = ''): void {
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', MUTATOR_SCRIPT, repo, mode, arg],
    { stdio: 'ignore', cwd: process.cwd() }
  );
}

async function setupRepo(repo: string): Promise<void> {
  const gp = { repositoryPath: repo, offline: true, local: true };
  const run = (op: ReturnType<typeof lore.repositoryCreate>): Promise<unknown> =>
    op.callback(() => {}).waitAsync();
  await run(lore.repositoryCreate(gp, { repositoryUrl: 'https://example.invalid/repro', id: '' }));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  await run(lore.fileStage(gp, { paths: ['.'], scan: true }) as never);
  await run(lore.revisionCommit(gp, { message: 'base commit' }) as never);
  await run(lore.branchCreate(gp, { branch: 'feature' }) as never);
  await run(lore.branchSwitch(gp, { branch: 'main' }) as never);
}

describe('WorkspaceModelService freshness against an external process (B2)', () => {
  let repo: string;
  let model: WorkspaceModelService;

  beforeAll(async () => {
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-ud-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-repo-'));
    await setupRepo(repo);

    const loreSvc = new LoreRepositoryService();
    const diff = new DiffService(loreSvc);
    // The anchor (card-view repo) is resolved live from the SDK via
    // resolveAnchorWorkspace (listBranches / getCurrentRevision); only the
    // registry record it hangs off is stubbed (registry identity is not the
    // freshness concern). workspaces.list returns no siblings, so the single
    // card under test IS the live-read anchor.
    const repoRecord: Repository = {
      id: REPO_ID,
      name: 'repro',
      localPath: repo,
      url: 'https://example.invalid/repro',
      origin: 'attached',
    } as Repository;
    const deps: WorkspaceModelDeps = {
      workspaces: {
        list: async () => [],
        on: () => undefined,
        off: () => undefined,
      },
      observer: { listSessions: () => [], on: () => undefined, off: () => undefined },
      transcript: { extract: async () => ({}) as never },
      lore: loreSvc as unknown as WorkspaceModelDeps['lore'],
      diff: diff as unknown as WorkspaceModelDeps['diff'],
      repository: { getById: async () => repoRecord },
    };
    model = new WorkspaceModelService(noopLog, deps);
  });

  afterAll(() => {
    lore.shutdown();
  });

  it('reflects an external BRANCH SWITCH on the next snapshot (no repositoryRelease)', async () => {
    // Given: the anchor is on main
    const before = await model.snapshot(REPO_ID);
    const anchorBefore = before.cards.find(c => c.workspace.path === repo);
    expect(anchorBefore?.workspace.branchName).toBe('main');

    // When: a SEPARATE process switches the checkout to feature
    runMutator(repo, 'switch', 'feature');

    // Then: the very next snapshot reflects it — no cache invalidation needed
    const after = await model.snapshot(REPO_ID);
    const anchorAfter = after.cards.find(c => c.workspace.path === repo);
    expect(anchorAfter?.workspace.branchName).toBe('feature');
  });

  it('reflects an external COMMIT on the next snapshot (no repositoryRelease)', async () => {
    // Given: back on main, capture the current revision
    runMutator(repo, 'switch', 'main');
    const before = await model.snapshot(REPO_ID);
    const revBefore = before.cards.find(c => c.workspace.path === repo)?.workspace.revision;

    // When: a SEPARATE process commits on main
    runMutator(repo, 'commit');

    // Then: the anchor's revision advances on the next snapshot
    const after = await model.snapshot(REPO_ID);
    const revAfter = after.cards.find(c => c.workspace.path === repo)?.workspace.revision;
    expect(revAfter).toBeTruthy();
    expect(revAfter).not.toBe(revBefore);
  });
});
