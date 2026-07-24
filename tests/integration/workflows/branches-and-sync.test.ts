import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer, seedRepo, seedAndClone, secondClient, islandCavesFiles } from '../support/world';

test('switch to a teammate-created branch', async () => {
  await withServer(async ({ server, service }) => {
    const repo = await seedRepo(server, 'island-caves', islandCavesFiles());

    // Create + publish the second branch from the seeding working copy.
    await server.lore(['branch', 'create', 'feature/caves-lighting', '--repository', repo.workdir]);
    await server.lore(['branch', 'switch', 'feature/caves-lighting', '--repository', repo.workdir]);
    await server.lore(['branch', 'push', 'feature/caves-lighting', '--repository', repo.workdir]);

    const clonePath = await mkdtemp(join(tmpdir(), 'lore-maya-w4-'));
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
    const { repo, clonePath: mayaPath } = await seedAndClone(
      server,
      service,
      'island-caves',
      islandCavesFiles()
    );
    const before = await service.getCurrentRevision(mayaPath);

    const devin = await secondClient(server, repo.url, 'devin');
    await devin.commitAndPush(
      { 'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 200\nfaces: 96\n' },
      'Lighting fix for cave entrance'
    );
    const devinInfo = await server.lore(['branch', 'info', 'main', '--repository', devin.workdir]);

    await service.syncRepository(mayaPath);

    const after = await service.getCurrentRevision(mayaPath);
    assert.notEqual(after, before, 'expected current revision to advance after sync');
    assert.ok(
      devinInfo.stdout.includes(after),
      `expected Devin's branch-info to reference Maya's post-sync revision ${after}, got: ${devinInfo.stdout}`
    );
  });
});

test('divergence reads inSync / ahead / behindOrDiverged across the arc', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: mayaPath } = await seedAndClone(
      server,
      service,
      'island-caves',
      islandCavesFiles()
    );

    const clean = await service.getBranchDivergence(mayaPath, 'main');
    assert.equal(
      clean.state,
      'inSync',
      `expected inSync when clean, got: ${JSON.stringify(clean)}`
    );

    // Maya commits locally but does not push yet.
    await writeFile(
      join(mayaPath, 'meshes', 'cave-entrance.mesh'),
      'mesh-format-v1\nvertices: 512\n'
    );
    await service.stageFiles(mayaPath, [join(mayaPath, 'meshes/cave-entrance.mesh')]);
    await service.commit(mayaPath, 'Add more detail to cave entrance mesh');

    const ahead = await service.getBranchDivergence(mayaPath, 'main');
    assert.equal(
      ahead.state,
      'ahead',
      `expected ahead after local commit, got: ${JSON.stringify(ahead)}`
    );

    await service.push(mayaPath);

    const inSyncAfterPush = await service.getBranchDivergence(mayaPath, 'main');
    assert.equal(inSyncAfterPush.state, 'inSync');

    // Devin pushes a change of his own; Maya has not synced yet.
    const devin = await secondClient(server, repo.url, 'devin');
    await devin.commitAndPush(
      { 'textures/rock-diffuse.tga': Buffer.from([0x01, 0x02, 0x03, 0x04]) },
      'Retexture rock for the lighting pass'
    );

    const behind = await service.getBranchDivergence(mayaPath, 'main');
    assert.equal(
      behind.state,
      'behindOrDiverged',
      `expected behindOrDiverged before syncing, got: ${JSON.stringify(behind)}`
    );

    await service.syncRepository(mayaPath);

    const inSyncAgain = await service.getBranchDivergence(mayaPath, 'main');
    assert.equal(inSyncAgain.state, 'inSync');
  });
});
