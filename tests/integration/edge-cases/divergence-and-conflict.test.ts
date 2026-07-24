import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withServer, seedAndClone, secondClient, islandCavesFiles, abs } from '../support/world';
import type { LoreFileStatus } from '../../../src/shared/types';

// A non-conflicting divergence (Maya's unpushed commit vs Devin's unrelated
// pushed commit) reads behindOrDiverged, and a plain sync auto-merges both
// sides rather than refusing or discarding either.
test('diverged (non-overlapping) histories read behindOrDiverged and a plain sync merges both sides', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: mayaPath } = await seedAndClone(
      server,
      service,
      'island-caves',
      islandCavesFiles()
    );

    const mayaTexture = Buffer.from([0x54, 0x52, 0x55, 0x45, 0xaa, 0xbb, 0xcc]);
    await writeFile(join(mayaPath, 'textures/rock-diffuse.tga'), mayaTexture);
    await service.stageFiles(mayaPath, [abs(mayaPath, 'textures/rock-diffuse.tga')]);
    await service.commit(mayaPath, 'Maya retextures the rock (unpushed)');

    const devin = await secondClient(server, repo.url, 'devin');
    const devinMesh = 'mesh-format-v1\nvertices: 500\nfaces: 250\n';
    await devin.commitAndPush(
      { 'meshes/cave-entrance.mesh': devinMesh },
      'Devin reworks the cave entrance mesh'
    );

    const divergence = await service.getBranchDivergence(mayaPath, 'main');
    assert.equal(
      divergence.state,
      'behindOrDiverged',
      `expected behindOrDiverged for a genuine divergence, got: ${JSON.stringify(divergence)}`
    );
    assert.notEqual(divergence.latest, divergence.latestRemote);

    await assert.doesNotReject(
      service.syncRepository(mayaPath),
      'expected a plain sync over a non-conflicting divergence to complete, not throw'
    );

    const meshAfter = await readFile(join(mayaPath, 'meshes/cave-entrance.mesh'), 'utf8');
    const textureAfter = await readFile(join(mayaPath, 'textures/rock-diffuse.tga'));
    assert.equal(meshAfter, devinMesh, "expected Devin's mesh edit to have merged in");
    assert.deepEqual(
      textureAfter,
      mayaTexture,
      "expected Maya's local commit to survive the sync, not be discarded"
    );

    const statusAfter = await service.getFileStatus(mayaPath);
    assert.deepEqual(
      statusAfter,
      { untracked: [], unstaged: [], staged: [] },
      `expected a clean status after a non-conflicting merge sync, got: ${JSON.stringify(statusAfter)}`
    );
  });
});

// KNOWN BUG. When Maya and Devin both edit the same region of the same file,
// the SDK surfaces the pending merge (flagConflict / flagConflictUnresolved on
// the REPOSITORY_STATUS_FILE event, plus ~mine/~theirs/~base sibling files),
// but getFileStatus() and LoreFileStatus drop that flag, so a conflicted file
// is indistinguishable from an ordinary staged file. This asserts the correct
// behavior and is `todo` (non-blocking) until getFileStatus and LoreFileStatus
// surface the conflict.
test('an overlapping conflict must be visibly surfaced, not reported as a plain staged file', { todo: 'getFileStatus() drops the SDK conflict flag, so merge conflicts are invisible to users' }, async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: mayaPath } = await seedAndClone(
      server,
      service,
      'island-caves',
      islandCavesFiles()
    );

    await writeFile(
      join(mayaPath, 'meshes/cave-entrance.mesh'),
      'mesh-format-v1\nvertices: 999\n'
    );
    await service.stageFiles(mayaPath, [abs(mayaPath, 'meshes/cave-entrance.mesh')]);
    await service.commit(mayaPath, "Maya's conflicting edit (unpushed)");

    const devin = await secondClient(server, repo.url, 'devin');
    await devin.commitAndPush(
      { 'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 500\n' },
      "Devin's conflicting edit, pushed first"
    );

    await assert.doesNotReject(
      service.syncRepository(mayaPath),
      'expected the real server to surface the conflict via a pending merge, not throw'
    );

    const statusAfter = await service.getFileStatus(mayaPath);
    assert.notDeepEqual(
      statusAfter,
      { untracked: [], unstaged: [], staged: [] },
      'the app must not report the repo as clean when a merge conflict is pending'
    );
    const conflictedFile = statusAfter.staged.find(
      file => file.path === 'meshes/cave-entrance.mesh'
    );
    assert.ok(
      conflictedFile,
      `expected the conflicting file to appear staged (pending merge), got: ${JSON.stringify(statusAfter)}`
    );

    // getFileStatus() maps REPOSITORY_STATUS_FILE to { path, isUntracked,
    // isStaged } only, and LoreFileStatus has no conflict field, so
    // isConflicted is always undefined here.
    const conflictedWithFlag = conflictedFile as LoreFileStatus & { isConflicted?: boolean };
    assert.equal(
      conflictedWithFlag.isConflicted,
      true,
      `getFileStatus() does not surface the SDK's flagConflict for a pending merge ` +
        `conflict -- the file reads as an ordinary staged change. Expected isConflicted === true, ` +
        `got: ${JSON.stringify(conflictedFile)}`
    );
  });
});
