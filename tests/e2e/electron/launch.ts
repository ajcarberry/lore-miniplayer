import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killProcessTree } from './support/reaper';

// Requires `pnpm build` first — every spec launches the built app at this path.
// Exported as the suite's SAFE scoping key: the orphan reaper only ever kills
// Electron processes whose argv contains this exact absolute path.
export const APP_MAIN = path.join(process.cwd(), 'out/main/index.js');

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
// inherited environment.
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

// Close a launched app without ever letting teardown hang the run.
//
// `app.close()` waits on the main process's `will-quit`, which runs a
// synchronous, unbounded `lore.shutdown()` that blocks while the SDK's native
// threads join. That join occasionally overruns the whole test timeout, which
// surfaced as "Tearing down electronApp exceeded the test timeout" and left an
// orphaned Electron tree that could poison a later launch's firstWindow().
//
// So race the graceful close against a bound; if it overruns, SIGKILL the whole
// Electron process tree. Either way the process is gone before the next launch.
export async function closeAppBounded(app: ElectronApplication, timeoutMs = 15_000): Promise<void> {
  const pid = app.process().pid;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closedGracefully = await Promise.race([
    app
      .close()
      .then(() => true)
      .catch(() => false),
    new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  if (!closedGracefully && pid !== undefined) {
    killProcessTree(pid);
  }
}
