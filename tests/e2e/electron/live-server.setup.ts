// Shared setup for the live-server specs: reuses the integration harness's
// startLoreServer() and seeding helpers to drive the real Electron app against
// a live `loreserver`.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { isolatedHomeEnv } from '../../integration/harness/server';

export { startLoreServer } from '../../integration/harness/server';
export type { LoreTestServer } from '../../integration/harness/server';
export { seedRepo, secondClient, islandCavesFiles } from '../../integration/support/world';

// The app's main process drives the SDK's native FFI directly, which the
// harness's per-run HOME isolation (scoped to its `lore` CLI calls) does not
// cover. Left alone, the FFI reads and writes a global config file under the
// developer's real $HOME. Give each launched app its own throwaway HOME/XDG_*.
export async function isolatedFfiHomeEnv(): Promise<Record<string, string>> {
  const homeDir = await mkdtemp(join(tmpdir(), 'lore-miniplayer-e2e-home-'));
  return isolatedHomeEnv(homeDir);
}

// Stub the main process's native directory picker to resolve to `dirPath`,
// because Playwright cannot interact with a real OS dialog. Patches the shared
// `electron` module in the launched app, so it must run before the "Select base
// directory" button is clicked.
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
