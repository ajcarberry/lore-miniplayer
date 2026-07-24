import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Requires `pnpm build` first — every spec launches the built app at this path.
const APP_MAIN = path.join(process.cwd(), 'out/main/index.js');

// A fresh, isolated userData directory per launch (or shared across a
// relaunch pair, when the caller needs the on-disk config to survive) so e2e
// runs never read or write the real user's ~/Library/Application
// Support/lore-miniplayer profile — see src/main/index.ts's
// LORE_MINIPLAYER_USER_DATA override.
export function createTempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-miniplayer-e2e-'));
}

export function removeTempUserDataDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface LaunchedApp {
  readonly app: ElectronApplication;
  // The temp userData dir this instance ran against — pass it back into a
  // second launchApp() call to test behavior that persists across a relaunch
  // (e.g. window position).
  readonly userDataDir: string;
}

// Launches the built app against an isolated temp userData dir. Pass
// `userDataDir` (from a previous LaunchedApp) to relaunch against the same
// profile; omit it to get a fresh one. `extraEnv` merges on top of the
// inherited environment — the live-server specs use it to redirect HOME/XDG_*
// so the app's in-process Lore SDK FFI never touches the developer's real
// global Lore config (see tests/e2e/electron/live-server.setup.ts).
export async function launchApp(
  userDataDir?: string,
  extraEnv?: Record<string, string>
): Promise<LaunchedApp> {
  const dir = userDataDir ?? createTempUserDataDir();
  const app = await electron.launch({
    args: [APP_MAIN],
    env: { ...process.env, ...extraEnv, LORE_MINIPLAYER_USER_DATA: dir },
  });
  return { app, userDataDir: dir };
}
