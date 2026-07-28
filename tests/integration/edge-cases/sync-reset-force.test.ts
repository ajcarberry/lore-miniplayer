import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LoreOperationError } from '../../../src/main/services/lore-repository';
import { withServer, seedAndClone, secondClient, sampleFiles } from '../support/world';

const MESH_PATH = 'meshes/cave-entrance.mesh';

// A reset sync over a dirty, never-staged local edit discards the edit and
// matches the remote exactly (no remote-side change involved).
test('reset sync discards a dirty working copy and matches the remote', async () => {
  await withServer(async ({ server, service }) => {
    const { clonePath: user1Path } = await seedAndClone(server, service, 'repo1', sampleFiles());

    const originalContent = await readFile(join(user1Path, MESH_PATH), 'utf8');
    await writeFile(join(user1Path, MESH_PATH), 'HALF-FINISHED SCRATCH EDIT, never staged\n');

    const dirtyStatus = await service.getFileStatus(user1Path);
    assert.ok(
      dirtyStatus.unstaged.some(file => file.path === MESH_PATH),
      `expected the dirty edit to show up unstaged, got: ${JSON.stringify(dirtyStatus)}`
    );

    await service.syncRepository(user1Path, undefined, { reset: true });

    const contentAfter = await readFile(join(user1Path, MESH_PATH), 'utf8');
    assert.equal(
      contentAfter,
      originalContent,
      "expected the working copy to match the remote's content, local edit discarded"
    );

    const statusAfter = await service.getFileStatus(user1Path);
    assert.deepEqual(
      statusAfter,
      { untracked: [], unstaged: [], staged: [] },
      `expected a clean status after reset sync, got: ${JSON.stringify(statusAfter)}`
    );
  });
});

// With a dirty local edit and a conflicting remote change to the same file, a
// plain sync refuses ("Local modifications prevent synchronization") and
// leaves the edit untouched; a forced sync completes and lands on the remote.
test('a plain sync refuses over dirty local edits; force completes it', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath: user1Path } = await seedAndClone(
      server,
      service,
      'repo1',
      sampleFiles()
    );

    const dirtyContent = 'HALF-FINISHED SCRATCH EDIT, never staged\n';
    await writeFile(join(user1Path, MESH_PATH), dirtyContent);

    const user2 = await secondClient(server, repo.url, 'user2');
    const user2Mesh = 'mesh-format-v1\nvertices: 500\n';
    await user2.commitAndPush({ [MESH_PATH]: user2Mesh }, "user2's remote change");

    await assert.rejects(
      service.syncRepository(user1Path),
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

    const contentAfterRefusal = await readFile(join(user1Path, MESH_PATH), 'utf8');
    assert.equal(
      contentAfterRefusal,
      dirtyContent,
      "expected the refused sync to leave user1's dirty edit untouched"
    );

    await assert.doesNotReject(
      service.syncRepository(user1Path, undefined, { force: true }),
      'expected a forced sync to complete where a plain sync refused'
    );

    const contentAfterForce = await readFile(join(user1Path, MESH_PATH), 'utf8');
    assert.equal(
      contentAfterForce,
      user2Mesh,
      "expected the forced sync to land on the remote's content"
    );
  });
});
