// E9 -- When things are wrong. A fat-fingered server address and a
// reference to a repository that doesn't exist must each fail as a clean
// LoreOperationError with a useful message -- no hang, no unhandled throw,
// no raw FFI error leaking to the UI. Each test carries a short node:test
// timeout as a safety net against a real hang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoreOperationError, LoreRepositoryService } from '../../../src/main/services/lore-repository';
import { withServer } from '../support/world';

const FAST_FAILURE_TIMEOUT_MS = 10_000;

// A clean failure: the right error type, a useful message, and no raw FFI
// internals (koffi/segfault/pointer addresses) leaking through to the UI.
function expectCleanLoreError(error: unknown): true {
  assert.ok(error instanceof LoreOperationError, `expected a LoreOperationError, got: ${String(error)}`);
  assert.ok(error.message.length > 0, 'expected a non-empty, useful error message');
  assert.doesNotMatch(
    error.message,
    /\bffi\b|koffi|segfault|0x[0-9a-f]{4,}/i,
    `expected no raw FFI leakage in the message, got: ${error.message}`
  );
  return true;
}

function assertFast(start: number): void {
  assert.ok(
    Date.now() - start < FAST_FAILURE_TIMEOUT_MS,
    'expected the rejection well within the fast-failure timeout'
  );
}

// Given: an address with nothing listening (Maya fat-fingers the server)
// When: listRemoteRepositories is called against it
// Then: it rejects quickly as a LoreOperationError with a useful message --
//       confirmed empirically to reject in single-digit milliseconds against
//       a real closed port, not to hang
test(
  'E9: an unreachable server address rejects fast as a clean LoreOperationError',
  { timeout: FAST_FAILURE_TIMEOUT_MS },
  async () => {
    const service = new LoreRepositoryService();
    const start = Date.now();

    await assert.rejects(
      service.listRemoteRepositories('lore://127.0.0.1:1'),
      expectCleanLoreError,
      'expected listRemoteRepositories against an unreachable address to reject'
    );

    assertFast(start);
  }
);

// Given: a live server, but a repository name that was never created on it
// When: Maya clones that URL
// Then: it rejects as a clean LoreOperationError with a useful message
test(
  "E9: cloning a repository that doesn't exist rejects as a clean LoreOperationError",
  { timeout: FAST_FAILURE_TIMEOUT_MS },
  async () => {
    await withServer(async ({ server, service }) => {
      const clonePath = await mkdtemp(join(tmpdir(), 'lore-missing-repo-clone-'));
      const start = Date.now();

      await assert.rejects(
        service.cloneRepository(`${server.grpcUrl}/does-not-exist`, clonePath),
        expectCleanLoreError,
        'expected cloning a missing repository to reject'
      );

      assertFast(start);
    });
  }
);
