// Drives the real LoreRepositoryService against a live harness server. Avoids
// src/main/services/lore-sdk.ts (electron `app` dependency); the SDK runs
// without initializeLoreSdk()/logConfigure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer, seedAndClone } from './support/world';

test('service smoke: clone + list against a live server', async () => {
  await withServer(async ({ server, service }) => {
    const { repo, clonePath } = await seedAndClone(server, service, 'repo1', {
      'hello.txt': 'hello from the integration smoke test\n',
    });

    const remoteRepos = await service.listRemoteRepositories(server.grpcUrl);
    assert.ok(
      remoteRepos.some(entry => entry.name === 'repo1' && entry.url === repo.url),
      `expected 'repo1' in remote repository list, got: ${JSON.stringify(remoteRepos)}`
    );

    const branches = await service.listBranches(clonePath);
    const main = branches.find(branch => branch.name === 'main');
    assert.ok(main, `expected a 'main' branch in the clone, got: ${JSON.stringify(branches)}`);
    assert.equal(main?.isCurrent, true);

    const status = await service.getFileStatus(clonePath);
    assert.deepEqual(status.staged, []);
    assert.deepEqual(status.untracked, []);
    assert.deepEqual(status.unstaged, []);
  });
});
