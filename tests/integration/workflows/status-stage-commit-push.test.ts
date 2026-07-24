// W2 -- Edit, review, stage, commit, push. Maya tweaks a texture, adds a new
// mesh, stages a subset, commits, and pushes; a fresh status afterward is
// clean.
// W3 -- Second thoughts before committing. Maya stages a whole folder, then
// unstages one file before it lands in the commit; the rest still commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withServer, seedAndClone, islandCavesFiles, abs } from '../support/world';

// Given: Maya has a fresh clone of island-caves with one committed revision
// When: she edits a tracked texture, adds a new mesh, stages both, commits,
//       and pushes
// Then: getFileStatus groups the new file as untracked and the edited one as
//       unstaged before staging; both show staged after stageFiles; and a
//       fresh status is clean after commit + push
test('W2: edit, review, stage, commit, push leaves a clean status', async () => {
  await withServer(async ({ server, service }) => {
    const { clonePath } = await seedAndClone(server, service, 'island-caves', islandCavesFiles());

    // Edit an existing texture, add a new mesh
    await writeFile(
      join(clonePath, 'textures', 'rock-diffuse.tga'),
      Buffer.from([0x54, 0x52, 0x55, 0x45, 0x01, 0x02, 0xaa, 0xbb])
    );
    await writeFile(
      join(clonePath, 'meshes', 'cave-tunnel.mesh'),
      'mesh-format-v1\nvertices: 40\n'
    );

    const beforeStage = await service.getFileStatus(clonePath);
    assert.ok(
      beforeStage.untracked.some(f => f.path === 'meshes/cave-tunnel.mesh'),
      `expected cave-tunnel.mesh untracked, got: ${JSON.stringify(beforeStage)}`
    );
    assert.ok(
      beforeStage.unstaged.some(f => f.path === 'textures/rock-diffuse.tga'),
      `expected rock-diffuse.tga unstaged, got: ${JSON.stringify(beforeStage)}`
    );
    assert.deepEqual(beforeStage.staged, []);

    await service.stageFiles(clonePath, [
      abs(clonePath, 'meshes/cave-tunnel.mesh'),
      abs(clonePath, 'textures/rock-diffuse.tga'),
    ]);

    const afterStage = await service.getFileStatus(clonePath);
    const stagedPaths = afterStage.staged.map(f => f.path).sort();
    assert.deepEqual(stagedPaths, ['meshes/cave-tunnel.mesh', 'textures/rock-diffuse.tga']);
    assert.deepEqual(afterStage.untracked, []);
    assert.deepEqual(afterStage.unstaged, []);

    await service.commit(clonePath, 'Add cave tunnel mesh, retouch rock texture');
    await service.push(clonePath);

    const afterPush = await service.getFileStatus(clonePath);
    assert.deepEqual(afterPush, { untracked: [], unstaged: [], staged: [] });
  });
});

// Given: Maya has staged a whole folder of edits
// When: she unstages one file before committing
// Then: that file moves back to unstaged while the rest stay staged, and
//       committing lands only the still-staged files
test('W3: unstage one file before commit, the rest still land', async () => {
  await withServer(async ({ server, service }) => {
    const { clonePath } = await seedAndClone(server, service, 'island-caves', islandCavesFiles());

    await writeFile(
      join(clonePath, 'textures', 'moss-diffuse.tga'),
      Buffer.from([0x01, 0x02, 0x03])
    );
    await writeFile(
      join(clonePath, 'textures', 'lichen-diffuse.tga'),
      Buffer.from([0x04, 0x05, 0x06])
    );

    await service.stageFiles(clonePath, [
      abs(clonePath, 'textures/moss-diffuse.tga'),
      abs(clonePath, 'textures/lichen-diffuse.tga'),
    ]);

    const staged = await service.getFileStatus(clonePath);
    assert.deepEqual(staged.staged.map(f => f.path).sort(), [
      'textures/lichen-diffuse.tga',
      'textures/moss-diffuse.tga',
    ]);

    await service.unstageFiles(clonePath, [abs(clonePath, 'textures/lichen-diffuse.tga')]);

    const afterUnstage = await service.getFileStatus(clonePath);
    assert.deepEqual(
      afterUnstage.staged.map(f => f.path),
      ['textures/moss-diffuse.tga']
    );
    assert.ok(
      afterUnstage.untracked.some(f => f.path === 'textures/lichen-diffuse.tga'),
      `expected lichen-diffuse.tga back among untracked, got: ${JSON.stringify(afterUnstage)}`
    );

    await service.commit(clonePath, 'Retexture moss only');
    await service.push(clonePath);

    const afterPush = await service.getFileStatus(clonePath);
    assert.deepEqual(afterPush.staged, []);
    assert.ok(
      afterPush.untracked.some(f => f.path === 'textures/lichen-diffuse.tga'),
      'lichen-diffuse.tga should remain uncommitted (untracked) after the commit'
    );
  });
});
