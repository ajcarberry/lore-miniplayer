import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer, seedRepo, islandCavesFiles } from '../support/world';
import type { CloneProgress } from '../../../src/shared/types';

test('connect, list, and clone island-caves', async () => {
  await withServer(async ({ server, service }) => {
    const repo = await seedRepo(server, 'island-caves', islandCavesFiles());

    const remoteRepos = await service.listRemoteRepositories(server.grpcUrl);
    assert.ok(
      remoteRepos.some(entry => entry.name === 'island-caves' && entry.url === repo.url),
      `expected island-caves in remote repository list, got: ${JSON.stringify(remoteRepos)}`
    );

    const progressEvents: CloneProgress[] = [];
    service.on('cloneProgress', (progress: CloneProgress) => {
      progressEvents.push(progress);
    });

    const localPath = await mkdtemp(join(tmpdir(), 'lore-maya-clone-'));
    await service.cloneRepository(repo.url, localPath);

    assert.ok(progressEvents.length > 0, 'expected at least one cloneProgress event');
    assert.ok(
      progressEvents.every(progress => progress.localPath === localPath),
      `expected all cloneProgress events to reference ${localPath}`
    );

    const status = await service.checkRepositoryStatus(localPath);
    assert.deepEqual(status, { exists: true, isLoreRepo: true });
  });
});
