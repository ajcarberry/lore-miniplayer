import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LoreOperationError,
  LoreRepositoryService,
} from '../../../src/main/services/lore-repository';
import { withServer } from '../support/world';

const FAST_FAILURE_TIMEOUT_MS = 10_000;

// A clean failure: the right error type, a non-empty message, and no raw FFI
// internals (koffi/segfault/pointer addresses) in the message.
function expectCleanLoreError(error: unknown): true {
  assert.ok(
    error instanceof LoreOperationError,
    `expected a LoreOperationError, got: ${String(error)}`
  );
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

test(
  'an unreachable server address rejects fast as a clean LoreOperationError',
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

test(
  "cloning a repository that doesn't exist rejects as a clean LoreOperationError",
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
