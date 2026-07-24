import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, constants as fsConstants, readFile, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLoreBinaries } from './binaries';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CACHE_ROOT = join(REPO_ROOT, '.lore-test-cache', 'lore-bins');

async function expectedSdkVersion(): Promise<string> {
  const pkgPath = join(REPO_ROOT, 'node_modules', '@lore-vcs', 'sdk', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

test('cold call downloads and caches executable loreserver + lore binaries', async () => {
  const isolatedCacheRoot = join(tmpdir(), `lore-bins-cold-test-${randomUUID()}`);

  try {
    const result = await ensureLoreBinaries(undefined, isolatedCacheRoot);

    assert.equal(result.version, await expectedSdkVersion());
    for (const binPath of [result.loreserver, result.lore]) {
      assert.ok(
        binPath.startsWith(isolatedCacheRoot),
        `${binPath} should live under the isolated cache root`
      );
      await access(binPath, fsConstants.X_OK);
      const stats = await stat(binPath);
      assert.ok(stats.isFile(), `${binPath} should be a regular file`);
    }
  } finally {
    await rm(isolatedCacheRoot, { recursive: true, force: true });
  }
});

test('warm call reuses the shared cache and makes no network access', async () => {
  // Prime the shared cache. A no-op when already warmed, and safe to run
  // concurrently: installs are additive atomic renames, nothing is removed.
  await ensureLoreBinaries();

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    throw new Error('network should not be used on a warm cache hit');
  }) as typeof fetch;

  try {
    const result = await ensureLoreBinaries();

    assert.equal(fetchCalled, false, 'ensureLoreBinaries must not call fetch on a warm cache hit');
    assert.ok(result.loreserver.startsWith(CACHE_ROOT));
    assert.ok(result.lore.startsWith(CACHE_ROOT));
    await access(result.loreserver, fsConstants.X_OK);
    await access(result.lore, fsConstants.X_OK);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
