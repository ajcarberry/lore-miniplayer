import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServer, seedRepo, sampleFiles } from '../support/world';
import type { CloneProgress } from '../../../src/shared/types';

test('connect, list, and clone a seeded repository', async () => {
  await withServer(async ({ server, service }) => {
    const repo = await seedRepo(server, 'repo1', sampleFiles());

    const remoteRepos = await service.listRemoteRepositories(server.grpcUrl);
    assert.ok(
      remoteRepos.some(entry => entry.name === 'repo1' && entry.url === repo.url),
      `expected repo1 in remote repository list, got: ${JSON.stringify(remoteRepos)}`
    );

    const progressEvents: CloneProgress[] = [];
    service.on('cloneProgress', (progress: CloneProgress) => {
      progressEvents.push(progress);
    });

    const localPath = await mkdtemp(join(tmpdir(), 'lore-clone-'));
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
