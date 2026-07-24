import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLoreServer } from './server';

const execFileAsync = promisify(execFile);

// Given: no server has been started yet
// When: startLoreServer() is called
// Then: it resolves only once /health_check returns 200, with grpcUrl/httpUrl populated
test('health gate: resolves only after /health_check returns 200', async () => {
  const server = await startLoreServer();
  try {
    assert.ok(server.grpcUrl.startsWith('lore://127.0.0.1:'), server.grpcUrl);
    assert.ok(server.httpUrl.startsWith('http://127.0.0.1:'), server.httpUrl);

    const res = await fetch(`${server.httpUrl}/health_check`);
    assert.equal(res.status, 200);
  } finally {
    await server.stop();
  }
});

// Given: a running, hermetic server
// When: createRepo('alpha') is called
// Then: a subsequent repository list against the server includes 'alpha'
test('create + list: createRepo is visible in a server-side repository list', async () => {
  const server = await startLoreServer();
  try {
    const repo = await server.createRepo('alpha');
    assert.equal(repo.name, 'alpha');
    assert.equal(repo.url, `${server.grpcUrl}/alpha`);

    const { stdout } = await server.lore(['repository', 'list', server.grpcUrl]);
    assert.match(stdout, /alpha/);
  } finally {
    await server.stop();
  }
});

// Given: a server that created a repo, then was stopped
// When: a second server is started fresh
// Then: its repository list does NOT include the first server's repo -- proving
//       each startLoreServer() run has its own isolated storage
test("hermetic isolation: a second server does not see the first server's repos", async () => {
  const first = await startLoreServer();
  await first.createRepo('alpha');
  await first.stop();

  const second = await startLoreServer();
  try {
    const { stdout } = await second.lore(['repository', 'list', second.grpcUrl]);
    assert.doesNotMatch(stdout, /alpha/);
  } finally {
    await second.stop();
  }
});

// Given: a server started (and thus a loreserver child process spawned)
// When: stop() is awaited
// Then: no loreserver process with that pid remains alive
test('no orphans: stop() leaves no loreserver child process behind', async () => {
  const server = await startLoreServer();
  const pid = server.pid;
  await server.stop();

  await assert.rejects(execFileAsync('ps', ['-p', String(pid)]));
});
