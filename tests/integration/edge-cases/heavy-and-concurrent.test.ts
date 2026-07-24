import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { lore } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import { cloneProgressPercent } from '../../../src/main/services/lore-repository';
import { withServer, seedRepo, seedAndClone, abs } from '../support/world';
import type { CloneProgress } from '../../../src/shared/types';

// Cloning two tiny files plus one 48MB binary: the service's emitted progress
// reaches 100 for the right localPath, and a real mid-transfer count (2 of 3
// files done but under 1% of bytes) fed through cloneProgressPercent reads well
// below the ~67% a file-count ratio would give, proving it follows byte ratio.
test('heavy-asset clone progress advances by bytes, not file count', async () => {
  await withServer(async ({ server, service }) => {
    const files: Record<string, Buffer> = {
      'assets/tiny-a.bin': randomBytes(1024),
      'assets/tiny-b.bin': randomBytes(1024),
      'assets/huge.bin': randomBytes(48 * 1024 * 1024),
    };
    const repo = await seedRepo(server, 'heavy-assets', files);

    const progressEvents: CloneProgress[] = [];
    service.on('cloneProgress', (progress: CloneProgress) => {
      progressEvents.push(progress);
    });

    const servicePath = await mkdtemp(join(tmpdir(), 'lore-heavy-service-clone-'));
    await service.cloneRepository(repo.url, servicePath);

    assert.ok(progressEvents.length > 1, 'expected more than one cloneProgress event');
    assert.ok(
      progressEvents.every(progress => progress.localPath === servicePath),
      `expected every cloneProgress event to reference ${servicePath}`
    );
    const lastProgress = progressEvents[progressEvents.length - 1];
    assert.equal(lastProgress?.percent, 100, `expected the final progress to reach 100, got: ${JSON.stringify(progressEvents)}`);

    // Raw SDK clone to capture a genuine mid-transfer count for the
    // byte-vs-file-ratio assertion below.
    const rawPath = await mkdtemp(join(tmpdir(), 'lore-heavy-raw-clone-'));
    const rawCounts: { fileComplete: number; fileCount: number; bytesTransferred: number; bytesTotal: number }[] = [];
    await lore
      .repositoryClone({ repositoryPath: rawPath }, { repositoryUrl: repo.url })
      .callback(event => {
        if (event.tag === LoreEventTag.REPOSITORY_CLONE_PROGRESS) {
          rawCounts.push(event.clone().data.count);
        }
      })
      .waitAsync();

    const midTransfer = rawCounts.find(
      count => count.bytesTotal > 0 && count.fileComplete > 0 && count.fileComplete < count.fileCount
    );
    assert.ok(
      midTransfer,
      `expected at least one mid-transfer progress count (some but not all files complete, bytesTotal known), got: ${JSON.stringify(rawCounts)}`
    );
    const fileRatioPercent = Math.round((midTransfer.fileComplete / midTransfer.fileCount) * 100);
    const actualPercent = cloneProgressPercent(midTransfer);
    assert.ok(
      actualPercent < fileRatioPercent,
      `expected the byte ratio (${actualPercent}%) to read well below the file-count ratio ` +
        `(${fileRatioPercent}%) while the huge file is still in flight -- count: ${JSON.stringify(midTransfer)}`
    );
  });
});

// Three files staged/committed/pushed back-to-back with no delay: each cycle's
// status and divergence reflect only that cycle's state, with no leaked
// untracked/staged entries and no stale divergence reading between cycles.
test('rapid-fire stage/commit/push cycles leave no stale state between them', async () => {
  await withServer(async ({ server, service }) => {
    const { clonePath: mayaPath } = await seedAndClone(server, service, 'island-caves', {
      'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 1\n',
    });

    const fileNames = ['assets/rapid-a.bin', 'assets/rapid-b.bin', 'assets/rapid-c.bin'];

    for (const relPath of fileNames) {
      const fullPath = join(mayaPath, relPath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, randomBytes(64));
      await service.stageFiles(mayaPath, [abs(mayaPath, relPath)]);
      await service.commit(mayaPath, `Add ${relPath}`);
      await service.push(mayaPath);

      const status = await service.getFileStatus(mayaPath);
      assert.deepEqual(
        status,
        { untracked: [], unstaged: [], staged: [] },
        `expected a clean status immediately after pushing ${relPath}, got: ${JSON.stringify(status)}`
      );

      const divergence = await service.getBranchDivergence(mayaPath, 'main');
      assert.equal(
        divergence.state,
        'inSync',
        `expected inSync immediately after pushing ${relPath}, got: ${JSON.stringify(divergence)}`
      );
    }
  });
});
