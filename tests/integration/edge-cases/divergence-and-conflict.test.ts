import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withServer, seedAndClone, secondClient, sampleFiles, abs } from '../support/world';

// A non-conflicting divergence (user1's unpushed commit vs user2's unrelated
// pushed commit) reads behindOrDiverged, and a plain sync auto-merges both
// sides rather than refusing or discarding either.
test('diverged (non-overlapping) histories read behindOrDiverged and a plain sync merges both sides', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: user1Path } = await seedAndClone(
      server,
      service,
      'repo1',
      sampleFiles()
    );

    const user1Texture = Buffer.from([0x54, 0x52, 0x55, 0x45, 0xaa, 0xbb, 0xcc]);
    await writeFile(join(user1Path, 'textures/rock-diffuse.tga'), user1Texture);
    await service.stageFiles(user1Path, [abs(user1Path, 'textures/rock-diffuse.tga')]);
    await service.commit(user1Path, 'user1 retextures the rock (unpushed)');

    const user2 = await secondClient(server, repo.url, 'user2');
    const user2Mesh = 'mesh-format-v1\nvertices: 500\nfaces: 250\n';
    await user2.commitAndPush(
      { 'meshes/cave-entrance.mesh': user2Mesh },
      'user2 reworks the cave entrance mesh'
    );

    const divergence = await service.getBranchDivergence(user1Path, 'main');
    assert.equal(
      divergence.state,
      'behindOrDiverged',
      `expected behindOrDiverged for a genuine divergence, got: ${JSON.stringify(divergence)}`
    );
    assert.notEqual(divergence.latest, divergence.latestRemote);

    await assert.doesNotReject(
      service.syncRepository(user1Path),
      'expected a plain sync over a non-conflicting divergence to complete, not throw'
    );

    const meshAfter = await readFile(join(user1Path, 'meshes/cave-entrance.mesh'), 'utf8');
    const textureAfter = await readFile(join(user1Path, 'textures/rock-diffuse.tga'));
    assert.equal(meshAfter, user2Mesh, "expected user2's mesh edit to have merged in");
    assert.deepEqual(
      textureAfter,
      user1Texture,
      "expected user1's local commit to survive the sync, not be discarded"
    );

    const statusAfter = await service.getFileStatus(user1Path);
    assert.deepEqual(
      statusAfter,
      { untracked: [], unstaged: [], staged: [] },
      `expected a clean status after a non-conflicting merge sync, got: ${JSON.stringify(statusAfter)}`
    );
  });
});

// REFUTED on this branch. When user1 and user2 both edit the same region of
// the same file, the SDK surfaces the pending merge (flagConflict /
// flagConflictUnresolved on the REPOSITORY_STATUS_FILE event, plus
// ~mine/~theirs/~base sibling files), and getFileStatus() now maps
// flagConflict/flagConflictUnresolved/flagConflictAutomerged/flagConflictMine/
// flagConflictTheirs onto LoreFileStatus (conflict is a required field), so a
// conflicted file is no longer indistinguishable from an ordinary staged file.
test('an overlapping conflict must be visibly surfaced, not reported as a plain staged file', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: user1Path } = await seedAndClone(
      server,
      service,
      'repo1',
      sampleFiles()
    );

    await writeFile(
      join(user1Path, 'meshes/cave-entrance.mesh'),
      'mesh-format-v1\nvertices: 999\n'
    );
    await service.stageFiles(user1Path, [abs(user1Path, 'meshes/cave-entrance.mesh')]);
    await service.commit(user1Path, "user1's conflicting edit (unpushed)");

    const user2 = await secondClient(server, repo.url, 'user2');
    await user2.commitAndPush(
      { 'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 500\n' },
      "user2's conflicting edit, pushed first"
    );

    await assert.doesNotReject(
      service.syncRepository(user1Path),
      'expected the real server to surface the conflict via a pending merge, not throw'
    );

    const statusAfter = await service.getFileStatus(user1Path);
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

    // getFileStatus() now maps REPOSITORY_STATUS_FILE's flagConflict /
    // flagConflictUnresolved onto LoreFileStatus.conflict / conflictUnresolved
    // (not the never-existent `isConflicted` this test used to assert on).
    assert.equal(
      conflictedFile.conflict,
      true,
      `expected the pending merge to surface conflict: true, got: ${JSON.stringify(conflictedFile)}`
    );
    assert.equal(
      conflictedFile.conflictUnresolved,
      true,
      `expected the pending merge to surface conflictUnresolved: true, got: ${JSON.stringify(conflictedFile)}`
    );
  });
});
