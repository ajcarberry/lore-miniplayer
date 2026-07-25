import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLoreServer } from './server';

const execFileAsync = promisify(execFile);

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

test('no orphans: stop() leaves no loreserver child process behind', async () => {
  const server = await startLoreServer();
  const pid = server.pid;
  await server.stop();

  await assert.rejects(execFileAsync('ps', ['-p', String(pid)]));
});
