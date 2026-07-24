import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer, writeSeedFiles, abs } from '../support/world';

// A zero-revision repository: status, branches, current-revision, graph, and
// divergence each handle "nothing here yet" without throwing.
test('an empty repository degrades gracefully across every read', async () => {
  await withServer(async ({ server, service }) => {
    const repo = await server.createRepo('island-caves-2');
    const clonePath = await mkdtemp(join(tmpdir(), 'lore-empty-clone-'));

    await assert.doesNotReject(
      service.cloneRepository(repo.url, clonePath),
      'expected cloning a zero-revision repository to succeed'
    );

    const status = await service.getFileStatus(clonePath);
    assert.deepEqual(status, { untracked: [], unstaged: [], staged: [] });

    const branches = await service.listBranches(clonePath);
    const main = branches.find(branch => branch.name === 'main');
    assert.ok(main, `expected a 'main' branch even with no revisions, got: ${JSON.stringify(branches)}`);
    assert.equal(main?.isCurrent, true);
    assert.equal(main?.isDefault, true);

    const currentRevision = await service.getCurrentRevision(clonePath);
    assert.equal(currentRevision, '', 'expected the current revision to degrade to an empty string');

    const graph = await service.getBranchGraph(clonePath, 'main');
    assert.equal(graph.current, '');
    assert.deepEqual(graph.branch.revisions, []);
    assert.deepEqual(graph.mergesFromParent, []);
    assert.deepEqual(graph.mergesToParent, []);

    const divergence = await service.getBranchDivergence(clonePath, 'main');
    assert.equal(
      divergence.state,
      'unknown',
      `expected 'unknown' divergence for an unpublished/empty branch, got: ${JSON.stringify(divergence)}`
    );
  });
});

// Filenames with spaces, unicode, and accented characters (including a unicode
// directory) round-trip intact and categorize correctly through stage, commit,
// push, status, and a fresh clone.
test('awkward filenames round-trip through stage/commit/push and a fresh clone', async () => {
  await withServer(async ({ server, service }) => {
    const repo = await server.createRepo('awkward-names');
    const seedPath = await mkdtemp(join(tmpdir(), 'lore-awkward-seed-'));
    await service.cloneRepository(repo.url, seedPath);

    const awkwardFiles: Record<string, Buffer | string> = {
      'Rock — Ⅳ (final).png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      'caves/背景/wall.tga': Buffer.from([0x01, 0x02, 0x03]),
      "café's crate.mesh": 'mesh-format-v1\n',
    };
    await writeSeedFiles(seedPath, awkwardFiles);

    const beforeStage = await service.getFileStatus(seedPath);
    const untrackedPaths = beforeStage.untracked.map(file => file.path).sort();
    assert.deepEqual(
      untrackedPaths,
      Object.keys(awkwardFiles).sort(),
      `expected all awkward paths to round-trip through getFileStatus untracked, got: ${JSON.stringify(untrackedPaths)}`
    );

    await service.stageFiles(
      seedPath,
      untrackedPaths.map(relPath => abs(seedPath, relPath))
    );
    await service.commit(seedPath, 'Add awkward filenames');
    await service.push(seedPath);

    const afterPush = await service.getFileStatus(seedPath);
    assert.deepEqual(afterPush, { untracked: [], unstaged: [], staged: [] });

    const freshClonePath = await mkdtemp(join(tmpdir(), 'lore-awkward-clone-'));
    await service.cloneRepository(repo.url, freshClonePath);

    const cloneStatus = await service.getFileStatus(freshClonePath);
    assert.deepEqual(cloneStatus, { untracked: [], unstaged: [], staged: [] });

    const entries = await readdir(freshClonePath, { recursive: true });
    for (const relPath of Object.keys(awkwardFiles)) {
      assert.ok(
        entries.includes(relPath),
        `expected '${relPath}' to exist intact in the fresh clone, got entries: ${JSON.stringify(entries)}`
      );
    }
  });
});
