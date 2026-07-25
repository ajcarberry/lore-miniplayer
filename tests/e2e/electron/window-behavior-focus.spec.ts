import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';

// Moved out of window-behavior.spec.ts (unchanged apart from the move) into
// their own electron-focus project: these two need a real OS-granted window
// focus, which needs a visible window, so they can't run as part of the
// default hidden-mode local suite. Run with
// `playwright test --project=electron-focus`; see playwright.config.ts.
// Requires `pnpm build` first — launches the built app at out/main/index.js.

test.describe('Electron Window Behavior (focus)', () => {
  test('window should change opacity on focus/blur', async () => {
    // Given: The Electron app is launched
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Ensure window is focused first, polling until the OS actually delivers
    // focus rather than sleeping a fixed interval
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.focus();
    });
    const focusDeadline = Date.now() + 2000;
    let isFocused = await electronApp.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.isFocused()
    );
    while (!isFocused && Date.now() < focusDeadline) {
      await window.waitForTimeout(50);
      isFocused = await electronApp.evaluate(async ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isFocused()
      );
    }

    // Gaining focus depends on the OS window manager actually granting it to
    // the process, which some sandboxed/headless test runners cannot do
    // (win.focus() is a request, not a guarantee). Skip rather than assert a
    // false failure when that's the case here — closing the app first since
    // test.skip() aborts the test immediately, before any later cleanup runs.
    if (!isFocused) {
      await electronApp.close();
      removeTempUserDataDir(userDataDir);
      test.skip(true, 'OS did not grant the window real focus in this environment');
    }

    // Opacity should be 1.0 when focused
    const opacity = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      return win.getOpacity();
    });
    expect(opacity).toBe(1.0);

    // When: We blur the window (remove focus)
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.blur();
    });

    // Then: Opacity settles at 0.7 (semi-transparent when not focused) — poll,
    // since the change lands only when the OS delivers the blur event
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getOpacity()
        )
      )
      .toBe(0.7);

    // When: We focus the window again
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.focus();
    });

    // Then: Opacity returns to 1.0 (fully opaque when focused)
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getOpacity()
        )
      )
      .toBe(1.0);

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('an active notice suspends the unfocused dimming until it clears', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    // Named `page` (not `window` like the sibling tests) so the evaluate
    // callbacks below can reach the DOM global `window.electronAPI`.
    const page = await electronApp.firstWindow();
    const getOpacity = (): Promise<number> =>
      electronApp.evaluate(async ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getOpacity()
      );

    // Given: the window is not focused (the notice/dim decision needs a real
    // unfocused window; skip if the OS insists on keeping it focused)
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.blur();
    });
    const focused = await electronApp.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.isFocused()
    );
    test.skip(focused, 'OS kept the window focused in this environment');

    // When: the renderer reports no notice — through the real preload bridge
    await page.evaluate(() => window.electronAPI.window.setNoticeActive(false));

    // Then: the unfocused window is dimmed
    await expect.poll(getOpacity).toBe(0.7);

    // When: a notice activates (sync needed)
    await page.evaluate(() => window.electronAPI.window.setNoticeActive(true));

    // Then: the window un-dims immediately so the pill pulse stays visible
    await expect.poll(getOpacity).toBe(1.0);

    // When: the notice clears
    await page.evaluate(() => window.electronAPI.window.setNoticeActive(false));

    // Then: normal unfocused dimming resumes
    await expect.poll(getOpacity).toBe(0.7);

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });
});
