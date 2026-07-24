// End-to-end smoke: drives the REAL LoreRepositoryService against a live
// harness server. Does NOT import src/main/services/lore-sdk.ts (electron
// `app` dependency) -- the SDK works without initializeLoreSdk()/logConfigure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoreServer } from './harness/server';
import { LoreRepositoryService } from '../../src/main/services/lore-repository';

// Given: a live loreserver with a repo seeded with one committed + pushed revision
// When: the real LoreRepositoryService clones it, then lists remote repositories
//       and branches on the clone
// Then: the clone succeeds and the service's results reflect the seeded repo
test('service smoke: clone + list against a live server', async () => {
  const server = await startLoreServer();
  try {
    const seedDir = await mkdtemp(join(tmpdir(), 'lore-smoke-seed-'));
    const url = `${server.grpcUrl}/smoke`;
    await server.lore(['repository', 'create', url, '--repository', seedDir]);
    await writeFile(join(seedDir, 'hello.txt'), 'hello from the integration smoke test\n');
    await server.lore(['stage', '.', '--scan', '--repository', seedDir]);
    await server.lore(['commit', 'Initial commit', '--repository', seedDir]);
    await server.lore(['push', '--repository', seedDir]);

    const service = new LoreRepositoryService();
    const clonePath = await mkdtemp(join(tmpdir(), 'lore-smoke-clone-'));

    await service.cloneRepository(url, clonePath);

    const remoteRepos = await service.listRemoteRepositories(server.grpcUrl);
    assert.ok(
      remoteRepos.some(repo => repo.name === 'smoke' && repo.url === url),
      `expected 'smoke' in remote repository list, got: ${JSON.stringify(remoteRepos)}`
    );

    const branches = await service.listBranches(clonePath);
    const main = branches.find(branch => branch.name === 'main');
    assert.ok(main, `expected a 'main' branch in the clone, got: ${JSON.stringify(branches)}`);
    assert.equal(main?.isCurrent, true);

    const status = await service.getFileStatus(clonePath);
    assert.deepEqual(status.staged, []);
    assert.deepEqual(status.untracked, []);
    assert.deepEqual(status.unstaged, []);
  } finally {
    await server.stop();
  }
});
