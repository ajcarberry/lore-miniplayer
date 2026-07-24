// Shared setup for the WP6 UI-subset specs (live-server.spec.ts), which drive
// the real Electron app against a live harness `loreserver` instead of
// mocking it (see launch.ts's doc comment for why the rest of tests/e2e
// avoids the real server). Reuses tests/integration/harness/server.ts's
// startLoreServer() and tests/integration/support/world.ts's seeding helpers
// verbatim — no harness/service internals are touched here.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';

export { startLoreServer } from '../../integration/harness/server';
export type { LoreTestServer } from '../../integration/harness/server';
export { seedRepo, secondClient, islandCavesFiles } from '../../integration/support/world';

// The app's main process drives the SDK's native FFI directly (not the
// `lore` CLI), so harness/server.ts's per-run HOME isolation for its `lore`
// CLI calls never covers it. Left alone, the FFI reads/writes ONE real global
// config file under the developer's actual $HOME -- the exact hermeticity gap
// tests/integration/support/world.ts's ensureIsolatedFfiHome documents and
// fixes for the integration suite. Give each launched app instance its own
// throwaway HOME/XDG_* so these e2e runs never touch that file either.
export async function isolatedFfiHomeEnv(): Promise<Record<string, string>> {
  const homeDir = await mkdtemp(join(tmpdir(), 'lore-miniplayer-e2e-home-'));
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
  };
}

// Stub the main process's native directory picker so a test can drive
// AddRepositoryModal's "Select base directory" control without a real OS
// dialog (Playwright cannot interact with those) -- resolves it to `dirPath`
// as though the user had picked that folder. Patches the shared `electron`
// module object in the launched app's main process, so it must run before
// the "Select base directory" button is clicked.
export async function stubDirectoryPicker(
  app: ElectronApplication,
  dirPath: string
): Promise<void> {
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = ((): Promise<{ canceled: boolean; filePaths: string[] }> =>
      Promise.resolve({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, dirPath);
}

// A fresh temp dir to use as an AddRepositoryModal "base directory" pick —
// the repository itself clones into a friendlyName subfolder under it.
export async function createCloneBaseDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'lore-miniplayer-e2e-clone-'));
}
