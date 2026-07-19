import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';

// Requires `pnpm build` first — launches the built app at out/main/index.js.

const CARD_SIZE = [360, 680];
const PILL_SIZE = [368, 108];

function windowSize(electronApp: Awaited<ReturnType<typeof launchApp>>['app']): Promise<number[]> {
  return electronApp.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getSize()
  );
}

test.describe('Electron Window Behavior', () => {
  test('window is transparent + always-on-top, and morphs between card and pill footprints', async () => {
    // Given: The Electron app is launched on a fresh (disconnected) profile
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Then: disconnected shows the full card, so the window is card-sized
    await expect.poll(() => windowSize(electronApp)).toEqual(CARD_SIZE);

    const props = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      return {
        alwaysOnTop: win.isAlwaysOnTop(),
        resizable: win.isResizable(),
        hasShadow: win.hasShadow(),
      };
    });
    expect(props.alwaysOnTop).toBe(true);
    expect(props.resizable).toBe(false);
    // Electron has no direct isTransparent() getter; hasShadow: false is set
    // alongside transparent: true in src/main/index.ts, and the renderer's root
    // paints an explicitly transparent background — together these corroborate
    // the transparent: true window option.
    expect(props.hasShadow).toBe(false);
    const rootBackground = await window.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    expect(rootBackground).toBe('rgba(0, 0, 0, 0)');

    // When: connecting — the player recedes to the ambient pill
    await window.getByPlaceholder('lores://lore.example.com').fill('lore.example.com');
    await window.getByRole('button', { name: 'Connect' }).click();

    // Then: the window shrinks to the pill footprint, still not resizable
    await expect.poll(() => windowSize(electronApp)).toEqual(PILL_SIZE);
    const stillFixed = await electronApp.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.isResizable()
    );
    expect(stillFixed).toBe(false);

    await window.evaluate(() => localStorage.removeItem('lore-server-address'));
    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

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

  test('the pill position is restored across a relaunch', async () => {
    // Given: a connected app resting as the pill (so the window is the pill
    // footprint and the saved anchor is the pill's own position)
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();
    await window.getByPlaceholder('lores://lore.example.com').fill('lore.example.com');
    await window.getByRole('button', { name: 'Connect' }).click();
    await expect.poll(() => windowSize(electronApp)).toEqual(PILL_SIZE);

    // When: the pill is moved to a known position, past the debounced save
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setPosition(150, 200);
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    await electronApp.close();

    // And: the app is relaunched against the SAME profile (stored server keeps
    // it connected, so it reopens as the pill)
    const { app: relaunched } = await launchApp(userDataDir);
    await relaunched.firstWindow();
    const bounds = await relaunched.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getBounds()
    );

    // Then: the pill reopens at the saved position and footprint
    expect(bounds.x).toBe(150);
    expect(bounds.y).toBe(200);
    expect([bounds.width, bounds.height]).toEqual(PILL_SIZE);

    await relaunched.close();
    removeTempUserDataDir(userDataDir);
  });
});
