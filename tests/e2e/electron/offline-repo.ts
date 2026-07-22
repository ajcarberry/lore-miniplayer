import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/bootstrap-offline-repo.mjs'
);

// Creates a real, purely-local Lore repository (a `.lore/` dir) in a fresh
// temp directory — no live Lore server involved. This is what lets specs
// exercise Mission Control / the review window against a genuine `Repository`
// record (the app's own "add existing repository" path only needs a `.lore/`
// marker on disk — see src/main/services/lore-repository.ts's
// checkRepositoryStatus) rather than needing a real server clone (P1 finding
// b: shared-store clone needs a live server; offline is blocked).
//
// Bootstrapped in a standalone `node` subprocess (see ./fixtures/
// bootstrap-offline-repo.mjs) rather than importing the SDK into the
// Playwright test process, so the native library's lifecycle never touches
// the test runner's own process.
export function createOfflineLoreRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-miniplayer-e2e-repo-'));
  execFileSync(process.execPath, [FIXTURE_SCRIPT, dir], { stdio: 'inherit' });
  return dir;
}

export function removeOfflineLoreRepo(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
