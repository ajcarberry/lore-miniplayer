// E1 -- Diverged histories. Maya commits a texture change locally (unpushed).
// Meanwhile Devin pushes a DIFFERENT, non-overlapping change to the same
// branch. Maya's branch has genuinely diverged, not merely fallen behind.
// getBranchDivergence must read behindOrDiverged (not ahead), and a plain
// sync must not silently clobber Maya's local commit.
//
// E4 -- A merge conflict she has to see. Maya and Devin both edit the SAME
// region of the SAME file; Devin pushes first. When Maya syncs, the conflict
// must be surfaced, not swallowed as an ordinary staged change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer, seedRepo, secondClient, islandCavesFiles } from '../support/world';
import type { LoreFileStatus } from '../../../src/shared/types';

// stageFiles takes ABSOLUTE paths -- see status-stage-commit-push.test.ts.
function abs(repositoryPath: string, relPath: string): string {
  return join(repositoryPath, relPath);
}

// Given: Maya has committed (but not pushed) an edit to the texture, while
//        Devin has pushed an unrelated edit to the mesh on the same branch
// When: Maya reads divergence, then runs a plain sync
// Then: divergence reads behindOrDiverged (real hashes differ and Maya's
//       local history never saw Devin's hash); the sync completes without
//       throwing and BOTH edits survive -- confirmed empirically against the
//       real server: a non-conflicting divergence auto-merges cleanly rather
//       than refusing or discarding either side
test('E1: diverged (non-overlapping) histories read behindOrDiverged and a plain sync merges both sides', async () => {
  await withServer(async ({ server, service }) => {
    const repo = await seedRepo(server, 'island-caves', islandCavesFiles());
    const mayaPath = await mkdtemp(join(tmpdir(), 'lore-maya-e1-'));
    await service.cloneRepository(repo.url, mayaPath);

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

// Given: Maya and Devin both edit the SAME line of the SAME file; Devin
//        pushes his commit first
// When: Maya syncs
// Then: the real server does not throw and does not silently overwrite --
//       it produces a pending merge with the conflicting file left staged
//       (confirmed empirically: the SDK's REPOSITORY_STATUS_FILE event
//       carries flagConflict/flagConflictUnresolved = true for it, and the
//       working copy gets ~mine/~theirs/~base sibling files). But
//       getFileStatus() / LoreFileStatus never forward that flag to the
//       app -- a conflicted file is indistinguishable from an ordinary
//       staged file. This assertion documents the CORRECT behavior the app
//       should have and is a known, reported FINDING (see report) -- it is
//       expected to fail until getFileStatus (and LoreFileStatus) surface
//       flagConflict.
// Marked `todo`: this asserts the CORRECT behavior for a KNOWN, reported bug
// (getFileStatus drops the SDK's flagConflict; LoreFileStatus has no conflict
// field). node:test runs the body but reports a failure as todo, so it is
// non-blocking. Remove the `{ todo }` option to turn it into a hard assertion
// the moment the defect is fixed. See .claude/mission/log.md (WP5 finding).
test('E4: an overlapping conflict must be visibly surfaced, not reported as a plain staged file', { todo: 'known bug: getFileStatus() drops flagConflict — conflicts are invisible to users (follow-up)' }, async () => {
  await withServer(async ({ server, service }) => {
    const repo = await seedRepo(server, 'island-caves', islandCavesFiles());
    const mayaPath = await mkdtemp(join(tmpdir(), 'lore-maya-e4-'));
    await service.cloneRepository(repo.url, mayaPath);

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

    // FINDING: src/main/services/lore-repository.ts getFileStatus() (around
    // line 366-399) maps REPOSITORY_STATUS_FILE events to { path,
    // isUntracked, isStaged } only, dropping flagConflict /
    // flagConflictUnresolved entirely; LoreFileStatus (src/shared/types.ts
    // line 101) has no conflict field at all. Expected: a conflicted file
    // is distinguishable from an ordinary staged file. Actual: it is not --
    // isConflicted is always undefined.
    const conflictedWithFlag = conflictedFile as LoreFileStatus & { isConflicted?: boolean };
    assert.equal(
      conflictedWithFlag.isConflicted,
      true,
      `FINDING: getFileStatus() does not surface the SDK's flagConflict for a pending merge ` +
        `conflict -- the file reads as an ordinary staged change. Expected isConflicted === true, ` +
        `got: ${JSON.stringify(conflictedFile)}`
    );
  });
});
