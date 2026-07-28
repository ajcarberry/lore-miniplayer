import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withServer, seedAndClone, abs } from '../support/world';
import { DiffService, PATCH_TRUNCATION_LINE_CAP } from '../../../src/main/services/diff-service';

// DiffService.compare (review window compare picker): revision -> revision
// and revision -> working tree against real commits, with a real binary
// change flagged via the sentinel patch (not an empty-patch heuristic).
test('DiffService.compare: revision -> revision and revision -> working tree against real commits', async () => {
  await withServer(async ({ server, service }) => {
    const initialMesh = 'mesh-format-v1\nvertices: 128\nfaces: 64\n';
    const initialTexture = Buffer.from([0x54, 0x52, 0x55, 0x45, 0x00, 0x01, 0x02, 0x03]);
    const { clonePath } = await seedAndClone(server, service, 'repo1', {
      'meshes/cave-entrance.mesh': initialMesh,
      'textures/rock-diffuse.tga': initialTexture,
    });
    const r1 = await service.getCurrentRevision(clonePath);

    const editedMesh = 'mesh-format-v1\nvertices: 256\nfaces: 64\n';
    const editedTexture = Buffer.from([0x54, 0x52, 0x55, 0x45, 0xff, 0xff, 0x02, 0x03]);
    await writeFile(join(clonePath, 'meshes/cave-entrance.mesh'), editedMesh);
    await writeFile(join(clonePath, 'textures/rock-diffuse.tga'), editedTexture);
    await service.stageFiles(clonePath, [
      abs(clonePath, 'meshes/cave-entrance.mesh'),
      abs(clonePath, 'textures/rock-diffuse.tga'),
    ]);
    const r2 = await service.commit(clonePath, 'Bump vertex count, retexture rock');

    const diff = new DiffService(service);
    const revToRev = await diff.compare({
      repositoryPath: clonePath,
      source: { kind: 'revision', revision: r1 },
      target: { kind: 'revision', revision: r2 },
    });
    const meshBetweenRevs = revToRev.find(f => f.path === 'meshes/cave-entrance.mesh');
    assert.ok(meshBetweenRevs);
    assert.deepEqual(meshBetweenRevs.lineStats, { added: 1, removed: 1 });
    const textureBetweenRevs = revToRev.find(f => f.path === 'textures/rock-diffuse.tga');
    assert.ok(textureBetweenRevs);
    assert.equal(
      textureBetweenRevs.binary,
      true,
      `expected the binary change to be flagged via the sentinel, got: ${JSON.stringify(textureBetweenRevs)}`
    );

    // A further, uncommitted edit on top of r2.
    const workingMesh = 'mesh-format-v1\nvertices: 256\nfaces: 64\nlod: 2\n';
    await writeFile(join(clonePath, 'meshes/cave-entrance.mesh'), workingMesh);

    const revToWorking = await diff.compare({
      repositoryPath: clonePath,
      source: { kind: 'revision', revision: r2 },
      target: { kind: 'workingTree' },
    });
    const meshAgainstWorkingTree = revToWorking.find(f => f.path === 'meshes/cave-entrance.mesh');
    assert.ok(meshAgainstWorkingTree);
    assert.deepEqual(meshAgainstWorkingTree.lineStats, { added: 1, removed: 0 });
  });
});

// The 4000-line truncation rule: a >4000-line diff is truncated to the head,
// but lineStats reflects the FULL patch, computed before truncation.
test('DiffService.compare: truncates a >4000-line diff, with lineStats computed pre-truncation', async () => {
  await withServer(async ({ server, service }) => {
    const { clonePath } = await seedAndClone(server, service, 'repo1', {
      'meshes/giant.mesh': 'seed\n',
    });
    const r1 = await service.getCurrentRevision(clonePath);

    const lineCount = PATCH_TRUNCATION_LINE_CAP + 500;
    const giantContent = Array.from({ length: lineCount }, (_, i) => `line-${i}`).join('\n') + '\n';
    await writeFile(join(clonePath, 'meshes/giant.mesh'), giantContent);
    await service.stageFiles(clonePath, [abs(clonePath, 'meshes/giant.mesh')]);
    const r2 = await service.commit(clonePath, 'Replace giant.mesh with generated content');

    const diff = new DiffService(service);
    const result = await diff.compare({
      repositoryPath: clonePath,
      source: { kind: 'revision', revision: r1 },
      target: { kind: 'revision', revision: r2 },
    });
    const entry = result.find(f => f.path === 'meshes/giant.mesh');
    assert.ok(entry);
    assert.equal(
      entry.truncated,
      true,
      `expected the diff to be truncated, got: ${JSON.stringify(entry)}`
    );
    assert.equal(
      entry.lineStats?.added,
      lineCount,
      `expected lineStats to reflect the FULL patch pre-truncation, got: ${JSON.stringify(entry.lineStats)}`
    );
    assert.equal(entry.patch?.split('\n').length, PATCH_TRUNCATION_LINE_CAP);
  });
});
