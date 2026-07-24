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

// Given: an isolated, empty cache root (never the shared one other tests'
// spawned servers depend on — this suite runs concurrently)
// When: ensureLoreBinaries is called for the first time against that root
// Then: it downloads and unpacks both binaries into the version-pinned cache
//       path, and they are executable
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

// Given: the real, shared cache that other concurrently-running integration
// tests spawn `loreserver`/`lore` from — primed here (idempotent, additive
// only — never deleted) rather than in the cold-call test above, so this
// suite never races a delete against another file's spawned server
// When: ensureLoreBinaries is called again against that shared cache
// Then: it returns the same paths WITHOUT making any network request
test('warm call reuses the shared cache and makes no network access', async () => {
  // Prime the shared cache. A no-op if another concurrently-running test
  // file already warmed it; safe either way since installs are additive
  // (atomic rename into place) and nothing here is ever removed.
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
