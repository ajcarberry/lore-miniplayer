import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';

// The harness contract for every e2e launch: the app runs fully, but nothing
// appears on screen and nothing steals focus. Set LORE_MINIPLAYER_E2E_SHOW=1 to
// watch a run instead — this probe is meaningless then, so it skips.
test.describe('Hidden test mode', () => {
  test.skip(
    process.env['LORE_MINIPLAYER_E2E_SHOW'] === '1',
    'LORE_MINIPLAYER_E2E_SHOW=1 deliberately runs the suite visibly'
  );

  test('launches with no visible window or dock icon, and still drives the UI', async () => {
    // Given: The app is launched through the shared harness with no opt-in flags
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Then: The window exists but has never been shown, and on macOS the app
    // owns no dock icon
    const state = await electronApp.evaluate(({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return {
        windowCount: windows.length,
        isVisible: windows[0]?.isVisible() ?? null,
        dockVisible: process.platform === 'darwin' && app.dock ? app.dock.isVisible() : null,
      };
    });
    expect(state.windowCount).toBe(1);
    expect(state.isVisible).toBe(false);
    if (process.platform === 'darwin') {
      expect(state.dockVisible).toBe(false);
    }

    // And: The renderer still renders and accepts input on the never-shown window
    const addressInput = window.getByPlaceholder('lores://lore.example.com');
    await expect(addressInput).toBeVisible();
    await addressInput.fill('lore.example.com');
    await expect(window.getByRole('button', { name: 'Connect' })).toBeEnabled();

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });
});
