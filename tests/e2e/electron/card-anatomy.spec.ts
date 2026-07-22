import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';

// Requires `pnpm build` first — launches the built app at out/main/index.js.
//
// No live Lore server exists in this environment: connecting only reaches the
// SDK boundary (repository list/status are local-file checks, not network
// calls), so the card renders in its "connected, no repository selected yet"
// state. That is enough to exercise the anatomy, repo picker, and theme menu
// contracts below without a real server.

async function connectAndExpand(window: Page): Promise<void> {
  await window.getByPlaceholder('lores://lore.example.com').fill('lore.example.com');
  await window.getByRole('button', { name: 'Connect' }).click();
  // Connecting collapses straight to the pill (see morph.spec.ts); click it to
  // unfold the card so its contents are actually visible for these assertions.
  await window.locator('.morph-pill').click();
  await expect(window.getByText('On branch')).toBeVisible();
}

test.describe('Card anatomy', () => {
  test('shows transport, working set, history, and footer sections once connected', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Given: the app is connected and the card is expanded
    await connectAndExpand(window);

    // Then: the transport row (Sync / Commit / Push) is visible
    await expect(window.getByText('Sync', { exact: true })).toBeVisible();
    await expect(window.getByText('Commit', { exact: true })).toBeVisible();
    await expect(window.getByText('Push', { exact: true })).toBeVisible();

    // And: the working set and history sections are visible
    await expect(window.getByText('Working Set')).toBeVisible();
    await expect(window.getByText('History', { exact: true })).toBeVisible();

    // And: the footer's workspaces/server/theme icons are visible
    await expect(window.getByLabel('Workspaces')).toBeVisible();
    await expect(window.getByLabel('Server')).toBeVisible();
    await expect(window.getByLabel('Theme')).toBeVisible();

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('workspace picker opens the Add modal, which closes on cancel', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();
    await connectAndExpand(window);

    // When: the footer's Workspaces icon is clicked
    await window.getByLabel('Workspaces').click();

    // Then: the popover shows "Add workspace…" and "Refresh" rows
    const addRow = window.getByText('Add workspace…');
    await expect(addRow).toBeVisible();
    await expect(window.getByText('Refresh', { exact: true })).toBeVisible();

    // When: "Add workspace…" is clicked
    await addRow.click();

    // Then: the Add Workspace modal opens
    const modalTitle = window.getByText('Define Workspace');
    await expect(modalTitle).toBeVisible();

    // When: the modal is cancelled (Escape)
    await window.keyboard.press('Escape');

    // Then: the modal closes
    await expect(modalTitle).not.toBeVisible();

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('theme menu switches to dark and back to auto, persisting through config', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();
    await connectAndExpand(window);

    // When: the theme menu is opened and Dark is selected
    await window.getByLabel('Theme').click();
    await window.getByRole('menuitem', { name: 'Dark' }).click();

    // Then: the document root reflects the dark scheme, and it round-trips
    // through the config IPC (config:set -> config:get) rather than only
    // living in renderer state.
    await expect
      .poll(() =>
        window.evaluate(() => document.documentElement.getAttribute('data-mantine-color-scheme'))
      )
      .toBe('dark');
    await expect
      .poll(() =>
        // `window` here is the Playwright Page (see connectAndExpand's param),
        // so the evaluate callback reaches the page's global via globalThis
        // rather than shadowing it with that same name.
        window.evaluate(() =>
          globalThis.window.electronAPI.config
            .get()
            .then(result => (result.success ? result.data.themeMode : undefined))
        )
      )
      .toBe('dark');

    // When: Auto is selected again
    await window.getByLabel('Theme').click();
    await window.getByRole('menuitem', { name: 'Auto' }).click();

    // Then: the scheme is no longer forced dark, and config reflects 'auto'
    await expect
      .poll(() =>
        window.evaluate(() => document.documentElement.getAttribute('data-mantine-color-scheme'))
      )
      .not.toBe('dark');
    await expect
      .poll(() =>
        // `window` here is the Playwright Page (see connectAndExpand's param),
        // so the evaluate callback reaches the page's global via globalThis
        // rather than shadowing it with that same name.
        window.evaluate(() =>
          globalThis.window.electronAPI.config
            .get()
            .then(result => (result.success ? result.data.themeMode : undefined))
        )
      )
      .toBe('auto');

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });
});
