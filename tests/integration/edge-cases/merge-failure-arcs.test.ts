// The merge/landing failure arcs against a real loreserver (amendment bugs
// A2/A3/C3): a rejected push, a target that moved under the merge, unrelated
// staged work at completion time, a request that disagrees with the checkout,
// and an on-disk merge inherited by a fresh service instance. Each arc asserts
// the state the user is left in, because the bug in every case was the wedge,
// not the failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lore } from '@lore-vcs/sdk';
import { withServer, seedAndClone, secondClient, abs } from '../support/world';
import type { LoreTestServer } from '../harness/server';
import type { LoreRepositoryService } from '../../../src/main/services/lore-repository';
import { MergeService, MergeOperationError } from '../../../src/main/services/merge-service';
import type { MainLogger } from '../../../src/main/ipc/logger';

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
  readonly service: LoreRepositoryService;
  readonly merge: MergeService;
}

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
  return {
    repoUrl: repo.url,
    workspacePath: clonePath,
    service,
    merge: new MergeService(silentLog, service),
  };
}

async function freshClone(server: LoreTestServer, repoUrl: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'lore-landed-'));
  await server.lore(['clone', repoUrl, path]);
  return path;
}

// `lore branch protect` makes the server reject a push to the branch — a real
// push failure with the landing commit already on the local target branch.
async function setPushProtection(
  server: LoreTestServer,
  workspacePath: string,
  protect: boolean
): Promise<void> {
  await server.lore([
    'branch',
    protect ? 'protect' : 'unprotect',
    TARGET_BRANCH,
    '--repository',
    workspacePath,
  ]);
}

async function startMerge(scenario: Scenario): Promise<void> {
  await scenario.merge.start({
    repositoryPath: scenario.workspacePath,
    sourceBranch: SOURCE_BRANCH,
    targetBranch: TARGET_BRANCH,
  });
}

test('A3-push: a refused landing lands nothing at all, and the retry lands exactly one merge commit', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    await startMerge(scenario);
    await setPushProtection(server, scenario.workspacePath, true);

    // When: completing while the server refuses to advance the target
    const failure = await scenario.merge.complete({ repositoryPath: scenario.workspacePath }).then(
      () => undefined,
      (error: unknown) => error
    );

    // Then: a typed error naming the intact workspace merge commit
    assert.ok(
      failure instanceof MergeOperationError,
      `expected a typed error, got ${String(failure)}`
    );
    assert.match(failure.message, /failed to land/i);

    // And: the landing is atomic — nothing was left half-committed on the
    // target branch, locally or on the server
    const beforeRetry = await service.getBranchDivergence(scenario.workspacePath, TARGET_BRANCH);
    assert.equal(
      beforeRetry.state,
      'inSync',
      'a refused landing must leave the target branch exactly as it was'
    );

    // When: the cause clears and the user retries
    await setPushProtection(server, scenario.workspacePath, false);
    const { revision } = await scenario.merge.complete({
      repositoryPath: scenario.workspacePath,
    });

    // Then: the retry landed on the server, with exactly one merge commit —
    // the failed attempt left nothing behind to stack on
    const landedClone = await freshClone(server, scenario.repoUrl);
    const { stdout: history } = await server.lore(['history', '--repository', landedClone]);
    assert.match(history, new RegExp(revision));
    assert.equal(
      history.match(/Merge {5}:/g)?.length,
      1,
      `expected exactly one merge commit on ${TARGET_BRANCH} after the retry, got:\n${history}`
    );
    assert.equal(
      await readFile(join(landedClone, 'notes.txt'), 'utf8'),
      'alpha\nBRANCH-EDIT\ncharlie\n'
    );
    // And: the workspace checkout never left its own branch
    const branches = await service.listBranches(scenario.workspacePath);
    assert.equal(branches.find(branch => branch.isCurrent)?.name, SOURCE_BRANCH);
  });
});

test('staged pre-flight: the user\'s own staged work is refused by name instead of the SDK\'s "Cannot merge with staged state"', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);

    // Given: the user (or the agent) has staged work in the checkout
    await writeFile(join(scenario.workspacePath, 'other.txt'), 'untouched\nSTAGED WORK\n');
    await service.stageFiles(scenario.workspacePath, [abs(scenario.workspacePath, 'other.txt')]);

    // When/Then: starting the merge is refused with an actionable, typed error
    const failure = await scenario.merge
      .start({
        repositoryPath: scenario.workspacePath,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    assert.ok(
      failure instanceof MergeOperationError,
      `expected a typed error, got ${String(failure)}`
    );
    assert.match(failure.message, /other\.txt/);
    assert.match(failure.message, /unstage|commit/i);
    assert.doesNotMatch(failure.message, /staged state/i);

    // And: the user's staged work is untouched — nothing was discarded for them
    assert.deepEqual(
      (await service.getFileStatus(scenario.workspacePath)).staged.map(file => file.path),
      ['other.txt']
    );

    // And: unstaging it lets the merge run
    await service.unstageFiles(scenario.workspacePath, [abs(scenario.workspacePath, 'other.txt')]);
    const state = await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
    assert.equal(state.sourceBranch, SOURCE_BRANCH);
  });
});

test('A2-restart-import: a stale merge that only IMPORTED files (no merge flags on any row) is backed out and re-run', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);

    // Given: the target gained a file the branch never had, so the merge is
    // clean and its only trace is a STAGED row carrying no merge flag at all
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await user2.commitAndPush({ 'pillar.txt': 'raised\n' }, 'another author adds a file to main');
    await startMerge(scenario);
    const stale = await service.getFileStatus(scenario.workspacePath);
    assert.deepEqual(
      stale.staged.map(file => ({ path: file.path, conflict: file.conflict })),
      [{ path: 'pillar.txt', conflict: false }],
      'the stale merge leaves a staged row with no merge signature'
    );

    // And: the app restarted — the on-disk merge survives, the record does not
    const afterRestart = new MergeService(silentLog, service);

    // When: the review window starts the merge again
    const state = await afterRestart.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });

    // Then: the unsigned stale merge was recognised, backed out and re-run —
    // not reported as the user's own staged work, and not left wedged
    assert.equal(state.sourceBranch, SOURCE_BRANCH);
    const { revision } = await afterRestart.complete({
      repositoryPath: scenario.workspacePath,
    });
    const landedClone = await freshClone(server, scenario.repoUrl);
    const { stdout: history } = await server.lore(['history', '--repository', landedClone]);
    assert.match(history, new RegExp(revision));
  });
});

test('tolerant abort: aborting when no merge is in progress succeeds as a no-op', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);

    // When: the start-error affordance aborts a merge that never started
    const result = await scenario.merge.abort({ repositoryPath: scenario.workspacePath });

    // Then: it reports that there was nothing to abort, rather than throwing
    assert.deepEqual(result, { aborted: false });
    assert.deepEqual(await service.getFileStatus(scenario.workspacePath), {
      untracked: [],
      unstaged: [],
      staged: [],
    });

    // And: an on-disk merge with no in-flight record IS backed out by abort
    const orphan = new MergeService(silentLog, service);
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await user2.commitAndPush(
      { 'notes.txt': 'alpha\nMAIN-EDIT\ncharlie\n' },
      'another author edits the same line on main'
    );
    await startMerge(scenario);
    assert.deepEqual(await orphan.abort({ repositoryPath: scenario.workspacePath }), {
      aborted: true,
    });
    assert.deepEqual(await service.getFileStatus(scenario.workspacePath), {
      untracked: [],
      unstaged: [],
      staged: [],
    });
  });
});

test('A3-advanced: a target that moved under the merge fails with an actionable error and leaves the workspace able to re-merge', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    await startMerge(scenario);

    // Given: another author lands an overlapping edit on the target AFTER the
    // merge was reviewed
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await user2.commitAndPush(
      { 'notes.txt': 'alpha\nMAIN-LATE-EDIT\ncharlie\n' },
      'another author lands on main mid-merge'
    );

    // When: completing
    const failure = await scenario.merge.complete({ repositoryPath: scenario.workspacePath }).then(
      () => undefined,
      (error: unknown) => error
    );

    // Then: the error names the cause and the recovery, rather than the
    // internal "unexpected conflict" surprise
    assert.ok(
      failure instanceof MergeOperationError,
      `expected a typed error, got ${String(failure)}`
    );
    assert.match(
      failure.message,
      /advanced/i,
      `expected the error to name the moved target, got: ${failure.message}`
    );

    // And: the checkout is clean, on its own branch, with no stranded merge
    assert.deepEqual(await service.getFileStatus(scenario.workspacePath), {
      untracked: [],
      unstaged: [],
      staged: [],
    });
    const branches = await service.listBranches(scenario.workspacePath);
    assert.equal(branches.find(branch => branch.isCurrent)?.name, SOURCE_BRANCH);

    // And: the recovery the message promises actually works — a fresh merge
    // picks up the new target content, and resolving it lands both sides
    const restarted = await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
    assert.deepEqual(restarted.files, [{ path: 'notes.txt', state: 'conflict' }]);
    await scenario.merge.resolve({
      repositoryPath: scenario.workspacePath,
      path: 'notes.txt',
      resolution: 'mine',
    });
    const { revision } = await scenario.merge.complete({
      repositoryPath: scenario.workspacePath,
    });
    const landedClone = await freshClone(server, scenario.repoUrl);
    const { stdout: history } = await server.lore(['history', '--repository', landedClone]);
    assert.match(history, new RegExp(revision));
    assert.equal(
      await readFile(join(landedClone, 'notes.txt'), 'utf8'),
      'alpha\nBRANCH-EDIT\ncharlie\n'
    );
  });
});

test('A3-dirty: unrelated staged work at completion time is refused, never swept into the merge commit', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    await startMerge(scenario);

    // Given: the user (or the agent) staged an unrelated file while the merge
    // was under review
    await writeFile(join(scenario.workspacePath, 'other.txt'), 'untouched\nUNRELATED WORK\n');
    await service.stageFiles(scenario.workspacePath, [abs(scenario.workspacePath, 'other.txt')]);

    // When/Then: completion is refused with a typed error naming the file
    const failure = await scenario.merge.complete({ repositoryPath: scenario.workspacePath }).then(
      () => undefined,
      (error: unknown) => error
    );
    assert.ok(
      failure instanceof MergeOperationError,
      `expected a typed error, got ${String(failure)}`
    );
    assert.match(failure.message, /other\.txt/);

    // And: nothing landed — the unrelated content is not on the server
    const landedClone = await freshClone(server, scenario.repoUrl);
    assert.equal(await readFile(join(landedClone, 'other.txt'), 'utf8'), 'untouched\n');

    // And: the merge is still in flight — unstaging the file lets it complete
    await service.unstageFiles(scenario.workspacePath, [abs(scenario.workspacePath, 'other.txt')]);
    const { revision } = await scenario.merge.complete({
      repositoryPath: scenario.workspacePath,
    });
    const afterClone = await freshClone(server, scenario.repoUrl);
    const { stdout: history } = await server.lore(['history', '--repository', afterClone]);
    assert.match(history, new RegExp(revision));
    assert.equal(await readFile(join(afterClone, 'other.txt'), 'utf8'), 'untouched\n');
  });
});

test("A3-import: a clean merge that imports a target-only file completes — the merge's own staged import is not read as unrelated work", async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);

    // Given: the target gained a file the branch never touched — nothing
    // overlaps, so the merge is clean, but branchMergeStart STAGES the import
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await user2.commitAndPush({ 'pillar.txt': 'raised\n' }, 'another author adds a file to main');
    await startMerge(scenario);

    // When: completing the clean merge
    const { revision } = await scenario.merge.complete({
      repositoryPath: scenario.workspacePath,
    });

    // Then: it landed — both sides are on the server
    const landedClone = await freshClone(server, scenario.repoUrl);
    const { stdout: history } = await server.lore(['history', '--repository', landedClone]);
    assert.match(history, new RegExp(revision));
    assert.equal(await readFile(join(landedClone, 'pillar.txt'), 'utf8'), 'raised\n');
    assert.equal(
      await readFile(join(landedClone, 'notes.txt'), 'utf8'),
      'alpha\nBRANCH-EDIT\ncharlie\n'
    );
  });
});

test("A3-import-dirty: an imported target-only file does not excuse the user's own staged work staged alongside it", async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await user2.commitAndPush({ 'pillar.txt': 'raised\n' }, 'another author adds a file to main');
    await startMerge(scenario);

    // Given: the user stages unrelated work while the merge is under review
    await writeFile(join(scenario.workspacePath, 'other.txt'), 'untouched\nUNRELATED WORK\n');
    await service.stageFiles(scenario.workspacePath, [abs(scenario.workspacePath, 'other.txt')]);

    // When/Then: completion is still refused, naming only the user's file
    const failure = await scenario.merge.complete({ repositoryPath: scenario.workspacePath }).then(
      () => undefined,
      (error: unknown) => error
    );
    assert.ok(
      failure instanceof MergeOperationError,
      `expected a typed error, got ${String(failure)}`
    );
    assert.match(failure.message, /other\.txt/);
    assert.doesNotMatch(
      failure.message,
      /pillar\.txt/,
      `the merge's own import must not be named as unrelated work: ${failure.message}`
    );
  });
});

test('C3: a start request whose sourceBranch is not the checked-out branch is refused before any merge is materialized', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);

    // When/Then: the request disagrees with the checkout
    const failure = await scenario.merge
      .start({
        repositoryPath: scenario.workspacePath,
        sourceBranch: 'agent/some-other-branch',
        targetBranch: TARGET_BRANCH,
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    assert.ok(
      failure instanceof MergeOperationError,
      `expected a typed error, got ${String(failure)}`
    );
    assert.match(failure.message, /agent\/some-other-branch/);
    assert.match(failure.message, new RegExp(SOURCE_BRANCH));

    // And: no merge was materialized on disk — the tree is untouched
    assert.deepEqual(await service.getFileStatus(scenario.workspacePath), {
      untracked: [],
      unstaged: [],
      staged: [],
    });

    // And: the correct request still works
    const state = await scenario.merge.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
    assert.equal(state.sourceBranch, SOURCE_BRANCH);
  });
});

test('A2-restart: a fresh service inheriting an on-disk merge restarts it cleanly instead of failing opaquely', async () => {
  await withServer(async ({ server, service }) => {
    const scenario = await seedWorkspace(server, service);
    const user2 = await secondClient(server, scenario.repoUrl, 'user2');
    await user2.commitAndPush(
      { 'notes.txt': 'alpha\nMAIN-EDIT\ncharlie\n' },
      'another author edits the same line on main'
    );
    await startMerge(scenario);

    // Given: the app restarted — the on-disk merge survives, the in-memory
    // record does not
    const afterRestart = new MergeService(silentLog, service);

    // When: the review window starts the merge again
    const state = await afterRestart.start({
      repositoryPath: scenario.workspacePath,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });

    // Then: the stale merge was backed out and re-run, so the same conflict is
    // reported and the merge is drivable to completion
    assert.deepEqual(state.files, [{ path: 'notes.txt', state: 'conflict' }]);
    await afterRestart.resolve({
      repositoryPath: scenario.workspacePath,
      path: 'notes.txt',
      resolution: 'mine',
    });
    const { revision } = await afterRestart.complete({
      repositoryPath: scenario.workspacePath,
    });
    const landedClone = await freshClone(server, scenario.repoUrl);
    const { stdout: history } = await server.lore(['history', '--repository', landedClone]);
    assert.match(history, new RegExp(revision));
    assert.equal(
      await readFile(join(landedClone, 'notes.txt'), 'utf8'),
      'alpha\nBRANCH-EDIT\ncharlie\n'
    );
  });
});
