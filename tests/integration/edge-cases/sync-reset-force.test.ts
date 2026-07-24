// E2 -- Reset sync over a messy working copy. Maya has half-finished, never
// staged local edits she wants to throw away and match the remote exactly.
//
// E3 -- Forced sync. Maya's dirty working copy and the remote have diverged
// and a normal sync refuses; she forces it. Empirically distinguished
// against the real server (see world.ts-driven probes in the report): a
// plain sync over UNCOMMITTED local modifications throws
// "Local modifications prevent synchronization" -- the real refusal case --
// while both --reset and --force complete it and land on the remote state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LoreOperationError } from '../../../src/main/services/lore-repository';
import { withServer, seedAndClone, secondClient, islandCavesFiles } from '../support/world';

const MESH_PATH = 'meshes/cave-entrance.mesh';

// Given: Maya has a dirty, never-staged local edit
// When: she runs a reset sync (no remote-side change involved)
// Then: the working copy matches the remote exactly and her edit is gone
test('E2: reset sync discards a dirty working copy and matches the remote', async () => {
  await withServer(async ({ server, service }) => {
    const { clonePath: mayaPath } = await seedAndClone(
      server,
      service,
      'island-caves',
      islandCavesFiles()
    );

    const originalContent = await readFile(join(mayaPath, MESH_PATH), 'utf8');
    await writeFile(join(mayaPath, MESH_PATH), 'HALF-FINISHED SCRATCH EDIT, never staged\n');

    const dirtyStatus = await service.getFileStatus(mayaPath);
    assert.ok(
      dirtyStatus.unstaged.some(file => file.path === MESH_PATH),
      `expected the dirty edit to show up unstaged, got: ${JSON.stringify(dirtyStatus)}`
    );

    await service.syncRepository(mayaPath, undefined, { reset: true });

    const contentAfter = await readFile(join(mayaPath, MESH_PATH), 'utf8');
    assert.equal(
      contentAfter,
      originalContent,
      "expected the working copy to match the remote's content, local edit discarded"
    );

    const statusAfter = await service.getFileStatus(mayaPath);
    assert.deepEqual(
      statusAfter,
      { untracked: [], unstaged: [], staged: [] },
      `expected a clean status after reset sync, got: ${JSON.stringify(statusAfter)}`
    );
  });
});

// Given: Maya has a dirty, never-staged local edit AND Devin has pushed a
//        different value for the same file
// When: she runs a plain sync
// Then: the real server refuses ("Local modifications prevent
//       synchronization") and leaves her edit untouched
// When: she then forces the sync
// Then: it completes and the working copy matches the remote's target state
test('E3: a plain sync refuses over dirty local edits; force completes it', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: mayaPath } = await seedAndClone(
      server,
      service,
      'island-caves',
      islandCavesFiles()
    );

    const dirtyContent = 'HALF-FINISHED SCRATCH EDIT, never staged\n';
    await writeFile(join(mayaPath, MESH_PATH), dirtyContent);

    const devin = await secondClient(server, repo.url, 'devin');
    const devinMesh = 'mesh-format-v1\nvertices: 500\n';
    await devin.commitAndPush({ [MESH_PATH]: devinMesh }, "Devin's remote change");

    await assert.rejects(
      service.syncRepository(mayaPath),
      (error: unknown) => {
        assert.ok(error instanceof LoreOperationError, 'expected a LoreOperationError');
        assert.match(
          error.message,
          /local modifications/i,
          `expected the refusal to mention local modifications, got: ${error.message}`
        );
        return true;
      },
      'expected a plain sync to refuse over dirty local edits that conflict with the incoming change'
    );

    const contentAfterRefusal = await readFile(join(mayaPath, MESH_PATH), 'utf8');
    assert.equal(
      contentAfterRefusal,
      dirtyContent,
      "expected the refused sync to leave Maya's dirty edit untouched"
    );

    await assert.doesNotReject(
      service.syncRepository(mayaPath, undefined, { force: true }),
      'expected a forced sync to complete where a plain sync refused'
    );

    const contentAfterForce = await readFile(join(mayaPath, MESH_PATH), 'utf8');
    assert.equal(
      contentAfterForce,
      devinMesh,
      "expected the forced sync to land on the remote's content"
    );
  });
});
