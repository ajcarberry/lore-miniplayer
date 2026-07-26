// MergeService against a real loreserver: the full "Integrate" arc (design 2c)
// — start the merge in the workspace checkout, resolve per file, complete, and
// land the merge commit on the target branch — verified from a THIRD clone, so
// "landed" means the server really advanced, not just the local store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lore } from '@lore-vcs/sdk';
import { withServer, seedAndClone, secondClient, abs } from '../support/world';
import type { LoreTestServer } from '../harness/server';
import type { LoreRepositoryService } from '../../../src/main/services/lore-repository';
import { MergeService } from '../../../src/main/services/merge-service';
import type { MainLogger } from '../../../src/main/ipc/logger';

// The service only ever logs; a no-op logger keeps the suite output readable
// while still exercising every log call site.
const silentLog = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  debug: (): void => undefined,
  verbose: (): void => undefined,
  log: (): void => undefined,
} as unknown as MainLogger;

const SOURCE_BRANCH = 'agent/cave-pass';
const TARGET_BRANCH = 'main';

interface Scenario {
  readonly repoUrl: string;
  readonly workspacePath: string;
  readonly merge: MergeService;
}

// A provisioned-workspace shape: a clone with a feature branch checked out that
// carries one commit the target lacks.
async function seedWorkspace(
  server: LoreTestServer,
  service: LoreRepositoryService
): Promise<Scenario> {
  const { repo, clonePath } = await seedAndClone(server, service, 'cavern', {
    'notes.txt': 'alpha\nbravo\ncharlie\n',
    'other.txt': 'untouched\n',
  });
  await lore.branchCreate({ repositoryPath: clonePath }, { branch: SOURCE_BRANCH }).waitAsync();
  await service.switchBranch(clonePath, SOURCE_BRANCH);
  await writeFile(join(clonePath, 'notes.txt'), 'alpha\nBRANCH-EDIT\ncharlie\n');
  await service.stageFiles(clonePath, [abs(clonePath, 'notes.txt')]);
  await service.commit(clonePath, 'agent edits the cave notes');
  return { repoUrl: repo.url, workspacePath: clonePath, merge: new MergeService(silentLog, service) };
}

// A third, independent clone — the only honest way to assert a landing: it can
// only see what the server actually holds on the target branch.
async function freshClone(server: LoreTestServer, repoUrl: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'lore-landed-'));
  await server.lore(['clone', repoUrl, path]);
  return path;
}

async function historyOf(server: LoreTestServer, clonePath: string): Promise<string> {
  const { stdout } = await server.lore(['history', '--repository', clonePath]);
  return stdout;
}

test('a clean merge lands the branch on the target: a fresh clone sees the merge revision on main', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);

    // Given: the branch is ahead of the target and merging the target in is clean
    const state = await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
    assert.equal(state.allResolved, true);
    assert.equal(
      state.hasChangesToLand,
      true,
      'the branch carries a commit the target lacks, so there is something to land'
    );

    // When: completing the merge
    const { revision } = await scenario.merge.complete({
      repositoryPath: scenario.workspacePath,
    });

    // Then: the landed revision is on the server's target branch, with the
    // branch's content, and the workspace checkout is back on its own branch
    const landedClone = await freshClone(server, scenario.repoUrl);
    assert.match(
      await historyOf(server, landedClone),
      new RegExp(revision),
      `expected the landed revision ${revision} in the target branch history`
    );
    assert.equal(
      await readFile(join(landedClone, 'notes.txt'), 'utf8'),
      'alpha\nBRANCH-EDIT\ncharlie\n'
    );
    const branches = await service.listBranches(scenario.workspacePath);
    assert.equal(
      branches.find(branch => branch.isCurrent)?.name,
      SOURCE_BRANCH,
      'the landing switch must always restore the workspace checkout'
    );
    assert.deepEqual(await service.getFileStatus(scenario.workspacePath), {
      untracked: [],
      unstaged: [],
      staged: [],
    });
  });
});

for (const resolution of ['mine', 'theirs'] as const) {
  const landedLine = resolution === 'mine' ? 'BRANCH-EDIT' : 'MAIN-EDIT';

  test(`an overlapping conflict resolved as ${resolution} lands the ${resolution} side on the target`, async () => {
    await withServer(async ({ server, service }) => {
      const scenario = await seedWorkspace(server, service);

      // Given: a second client pushed an overlapping edit to the target
      const user2 = await secondClient(server, scenario.repoUrl, 'user2');
      await user2.commitAndPush(
        { 'notes.txt': 'alpha\nMAIN-EDIT\ncharlie\n' },
        'another author edits the same line on main'
      );

      // When: the merge is started, the overlap is reported as a conflict
      const started = await scenario.merge.start({
        repositoryPath: scenario.workspacePath,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
      });
      assert.deepEqual(started.files, [{ path: 'notes.txt', state: 'conflict' }]);
      assert.equal(started.allResolved, false);
      assert.match(
        await readFile(join(scenario.workspacePath, 'notes.txt'), 'utf8'),
        /<<<<<<< ours[\s\S]*\|\|\|\|\|\|\| original[\s\S]*>>>>>>> theirs/,
        'the SDK materializes diff3 markers in the working file (P1e)'
      );

      // And: resolving the file picks a side and completes the merge
      const resolved = await scenario.merge.resolve({
        repositoryPath: scenario.workspacePath,
        path: 'notes.txt',
        resolution,
      });
      assert.deepEqual(resolved.files, [{ path: 'notes.txt', state: 'conflict', resolution }]);
      assert.equal(resolved.allResolved, true);

      const { revision } = await scenario.merge.complete({
        repositoryPath: scenario.workspacePath,
      });

      // Then: the target branch on the SERVER carries the chosen side
      const landedClone = await freshClone(server, scenario.repoUrl);
      assert.equal(
        await readFile(join(landedClone, 'notes.txt'), 'utf8'),
        `alpha\n${landedLine}\ncharlie\n`,
        `expected the ${resolution} side to be what landed on ${TARGET_BRANCH}`
      );
      assert.match(await historyOf(server, landedClone), new RegExp(revision));
    });
  });
}

test('a branch that already landed reports nothing left to merge', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
    await scenario.merge.complete({ repositoryPath: scenario.workspacePath });

    // When: the user opens the merge view again over the same branch
    const again = await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });

    // Then: the branch tip is already on the target, so there is nothing to
    // land — the merge view says "nothing to merge" and Merge stays disabled
    assert.equal(
      again.hasChangesToLand,
      false,
      'a branch whose tip is already merged into the target has nothing left to land'
    );
    await scenario.merge.abort({ repositoryPath: scenario.workspacePath });
  });
});

test('a branch landed EXTERNALLY (by another client) reports nothing left to merge', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    await lore
      .branchPush({ repositoryPath: scenario.workspacePath }, { branch: SOURCE_BRANCH })
      .waitAsync();

    // Given: another client merged the branch into the target and pushed, so
    // the landing exists only on the REMOTE target tip — this workspace's
    // local store still has the pre-merge target.
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await server.lore(['sync', '--repository', user2.workdir]);
    await server.lore(['branch', 'switch', SOURCE_BRANCH, '--repository', user2.workdir]);
    await server.lore([
      'branch',
      'merge',
      'into',
      TARGET_BRANCH,
      'landed externally',
      '--repository',
      user2.workdir,
    ]);

    // When: Mission Control asks whether this branch still has work to land
    const hasChangesToLand = await service.hasRevisionsToLand(
      scenario.workspacePath,
      SOURCE_BRANCH,
      TARGET_BRANCH
    );

    // Then: no — the ancestry against the target's REMOTE tip shows the branch
    // tip merged in already (the local target tip never saw it)
    assert.equal(hasChangesToLand, false, 'an externally landed branch has nothing left to land');
  });
});

test('a branch with a commit the target lacks still reports work to land', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);

    // When/Then: the fresh branch carries one unlanded commit
    assert.equal(
      await service.hasRevisionsToLand(scenario.workspacePath, SOURCE_BRANCH, TARGET_BRANCH),
      true
    );

    // And: after landing it, a NEW commit on the branch is work to land again
    await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
    await scenario.merge.complete({ repositoryPath: scenario.workspacePath });
    assert.equal(
      await service.hasRevisionsToLand(scenario.workspacePath, SOURCE_BRANCH, TARGET_BRANCH),
      false
    );
    await writeFile(join(scenario.workspacePath, 'notes.txt'), 'alpha\nSECOND-EDIT\ncharlie\n');
    await service.stageFiles(scenario.workspacePath, [
      abs(scenario.workspacePath, 'notes.txt'),
    ]);
    await service.commit(scenario.workspacePath, 'more agent edits');
    assert.equal(
      await service.hasRevisionsToLand(scenario.workspacePath, SOURCE_BRANCH, TARGET_BRANCH),
      true
    );
  });
});

test('aborting an in-flight merge restores the pre-merge working file and frees a new merge', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await user2.commitAndPush(
      { 'notes.txt': 'alpha\nMAIN-EDIT\ncharlie\n' },
      'another author edits the same line on main'
    );
    await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });

    // When: the merge is aborted
    const aborted = await scenario.merge.abort({ repositoryPath: scenario.workspacePath });

    // Then: the working file is the branch's own pre-merge content — no
    // markers, no target-side content — and the tree is clean
    assert.deepEqual(aborted, { aborted: true });
    assert.equal(
      await readFile(join(scenario.workspacePath, 'notes.txt'), 'utf8'),
      'alpha\nBRANCH-EDIT\ncharlie\n'
    );
    assert.deepEqual(await service.getFileStatus(scenario.workspacePath), {
      untracked: [],
      unstaged: [],
      staged: [],
    });

    // And: a new merge may be started afterwards
    const restarted = await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
    assert.equal(restarted.files.length, 1);
  });
});
