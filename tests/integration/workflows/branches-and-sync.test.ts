import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer, seedRepo, seedAndClone, secondClient, sampleFiles } from '../support/world';

test('switch to a teammate-created branch', async () => {
  await withServer(async ({ server, service }) => {
    const repo = await seedRepo(server, 'repo1', sampleFiles());

    // Create + publish the second branch from the seeding working copy.
    await server.lore(['branch', 'create', 'feature/caves-lighting', '--repository', repo.workdir]);
    await server.lore(['branch', 'switch', 'feature/caves-lighting', '--repository', repo.workdir]);
    await server.lore(['branch', 'push', 'feature/caves-lighting', '--repository', repo.workdir]);

    const clonePath = await mkdtemp(join(tmpdir(), 'lore-clone-'));
    await service.cloneRepository(repo.url, clonePath);

    const beforeSwitch = await service.listBranches(clonePath);
    const mainBefore = beforeSwitch.find(b => b.name === 'main');
    assert.equal(mainBefore?.isCurrent, true);
    assert.equal(mainBefore?.isDefault, true);

    await service.switchBranch(clonePath, 'feature/caves-lighting');

    const afterSwitch = await service.listBranches(clonePath);
    const feature = afterSwitch.find(b => b.name === 'feature/caves-lighting');
    const main = afterSwitch.find(b => b.name === 'main');
    assert.ok(
      feature,
      `expected feature/caves-lighting in branch list, got: ${JSON.stringify(afterSwitch)}`
    );
    assert.equal(feature?.isCurrent, true);
    assert.equal(main?.isCurrent, false);
    assert.equal(main?.isDefault, true);
  });
});

test('catch up with a teammate via sync', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: user1Path } = await seedAndClone(
      server,
      service,
      'repo1',
      sampleFiles()
    );
    const before = await service.getCurrentRevision(user1Path);

    const user2 = await secondClient(server, repo.url, 'user2');
    await user2.commitAndPush(
      { 'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 200\nfaces: 96\n' },
      'Lighting fix for cave entrance'
    );
    const user2Info = await server.lore(['branch', 'info', 'main', '--repository', user2.workdir]);

    await service.syncRepository(user1Path);

    const after = await service.getCurrentRevision(user1Path);
    assert.notEqual(after, before, 'expected current revision to advance after sync');
    assert.ok(
      user2Info.stdout.includes(after),
      `expected user2's branch-info to reference user1's post-sync revision ${after}, got: ${user2Info.stdout}`
    );
  });
});

test('divergence reads inSync / ahead / behindOrDiverged across the arc', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: user1Path } = await seedAndClone(
      server,
      service,
      'repo1',
      sampleFiles()
    );

    const clean = await service.getBranchDivergence(user1Path, 'main');
    assert.equal(
      clean.state,
      'inSync',
      `expected inSync when clean, got: ${JSON.stringify(clean)}`
    );

    // user1 commits locally but does not push yet.
    await writeFile(
      join(user1Path, 'meshes', 'cave-entrance.mesh'),
      'mesh-format-v1\nvertices: 512\n'
    );
    await service.stageFiles(user1Path, [join(user1Path, 'meshes/cave-entrance.mesh')]);
    await service.commit(user1Path, 'Add more detail to cave entrance mesh');

    const ahead = await service.getBranchDivergence(user1Path, 'main');
    assert.equal(
      ahead.state,
      'ahead',
      `expected ahead after local commit, got: ${JSON.stringify(ahead)}`
    );

    await service.push(user1Path);

    const inSyncAfterPush = await service.getBranchDivergence(user1Path, 'main');
    assert.equal(inSyncAfterPush.state, 'inSync');

    // user2 pushes its own change; user1 has not synced yet.
    const user2 = await secondClient(server, repo.url, 'user2');
    await user2.commitAndPush(
      { 'textures/rock-diffuse.tga': Buffer.from([0x01, 0x02, 0x03, 0x04]) },
      'Retexture rock for the lighting pass'
    );

    const behind = await service.getBranchDivergence(user1Path, 'main');
    assert.equal(
      behind.state,
      'behindOrDiverged',
      `expected behindOrDiverged before syncing, got: ${JSON.stringify(behind)}`
    );

    await service.syncRepository(user1Path);

    const inSyncAgain = await service.getBranchDivergence(user1Path, 'main');
    assert.equal(inSyncAgain.state, 'inSync');
  });
});
