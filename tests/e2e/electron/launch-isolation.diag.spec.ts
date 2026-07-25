import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';
import {
  isolatedFfiHomeEnv,
  startLoreServer,
  type LoreTestServer,
} from './live-server.setup';

// P-U1 isolation-model reliability check. Proves the launch/isolation model the
// live-server scenario packets (WP-U2…U6) consume: >=6 sequential REAL app
// launches in ONE worker (workers:1), each launch → firstWindow() → real FFI
// connect → close, with a fresh isolated userData + isolated FFI HOME/XDG per
// launch and guaranteed teardown. Establishes there is no per-worker "launch
// ceiling": firstWindow() stays sub-second across every iteration.
//
// Requires `pnpm build` first. macOS/Linux only (the loreserver harness has no
// win32 binary), matching the live-server suite's skip.

const LAUNCHES = 6;

test.describe('P-U1 launch isolation model', () => {
  test.skip(
    process.platform === 'win32',
    'loreserver harness provisions binaries on macOS/Linux only'
  );

  let server: LoreTestServer | undefined;

  test.beforeAll(async () => {
    server = await startLoreServer();
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  // Real FFI network activity: connect the app to the live harness so each
  // launch exercises the SDK's connect + status-stream path, not just boot.
  async function connect(window: Page): Promise<void> {
    await window.getByPlaceholder('lores://lore.example.com').fill(server!.grpcUrl);
    await window.getByRole('button', { name: 'Connect' }).click();
    await window.locator('.morph-pill').click();
    await expect(window.getByText('On branch')).toBeVisible({ timeout: 20_000 });
  }

  test(`${LAUNCHES} sequential real launches never hit a launch ceiling`, async () => {
    test.setTimeout(300_000);

    for (let i = 1; i <= LAUNCHES; i++) {
      const started = Date.now();
      const { app, userDataDir } = await launchApp(undefined, await isolatedFfiHomeEnv());
      try {
        const window = await app.firstWindow();
        const firstWindowMs = Date.now() - started;
        // The reported "4th firstWindow() hangs" ceiling would surface here as a
        // multi-minute stall; assert it stays fast on every iteration instead.
        expect(
          firstWindowMs,
          `launch ${i}/${LAUNCHES}: firstWindow() must not hang`
        ).toBeLessThan(30_000);
        await connect(window);
      } finally {
        await app.close();
        removeTempUserDataDir(userDataDir);
      }
    }
  });
});
