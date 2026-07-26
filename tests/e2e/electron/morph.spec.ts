import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';

// Requires `pnpm build` first — launches the built app at out/main/index.js.
//
// The pill<->card morph is click-driven AND resizes the real window: clicking
// the pill grows the window to the card footprint then unfolds the card; the
// title bar's collapse control folds the card then shrinks the window back to
// the pill footprint. The pill is dragged manually (not a native drag region),
// so Playwright's real pointer clicks reach it.

const CARD_SIZE = [360, 680];
const PILL_SIZE = [368, 108];

function isExpanded(window: Page): Promise<boolean> {
  return window.evaluate(
    () => document.querySelector('.morph-root')?.getAttribute('data-expanded') === 'true'
  );
}

function windowSize(electronApp: ElectronApplication): Promise<number[]> {
  return electronApp.evaluate(async ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getSize()
  );
}

async function connectAndSettleToPill(
  window: Page,
  electronApp: ElectronApplication
): Promise<void> {
  await window.getByPlaceholder('lores://lore.example.com').fill('lore.example.com');
  await window.getByRole('button', { name: 'Connect' }).click();
  await expect.poll(() => isExpanded(window)).toBe(false);
  await expect.poll(() => windowSize(electronApp)).toEqual(PILL_SIZE);
}

test.describe('Pill <-> card morph', () => {
  test('clicking the pill grows the window and expands the card', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Given: connected — the player rests as the collapsed pill
    await connectAndSettleToPill(window, electronApp);

    // When: the pill is clicked
    await window.locator('.morph-pill').click();

    // Then: the window grows to the card footprint and the card unfolds
    await expect.poll(() => windowSize(electronApp)).toEqual(CARD_SIZE);
    await expect.poll(() => isExpanded(window)).toBe(true);
    await expect(window.getByText('On branch')).toBeVisible();

    await window.evaluate(() => localStorage.removeItem('lore-server-address'));
    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('the pill floats clear of every window edge so the glow can render all around', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Given: connected — the player rests as the collapsed pill
    await connectAndSettleToPill(window, electronApp);

    // Then: the pill bar keeps a gutter on all four sides — the window is
    // transparent and nothing (box-shadow included) renders outside its
    // bounds, so a flush edge cuts the hover glow flat on that side.
    const gutters = await window.evaluate(() => {
      const rect = document.querySelector('.morph-pill-bar')!.getBoundingClientRect();
      // `globalThis`, not `window`: the enclosing test names its Page variable
      // `window`, which TypeScript would resolve here instead of the DOM global.
      return {
        top: rect.top,
        left: rect.left,
        right: globalThis.innerWidth - rect.right,
        bottom: globalThis.innerHeight - rect.bottom,
      };
    });
    const MIN_GLOW_GUTTER = 12;
    expect(gutters.top).toBeGreaterThanOrEqual(MIN_GLOW_GUTTER);
    expect(gutters.left).toBeGreaterThanOrEqual(MIN_GLOW_GUTTER);
    expect(gutters.right).toBeGreaterThanOrEqual(MIN_GLOW_GUTTER);
    expect(gutters.bottom).toBeGreaterThanOrEqual(MIN_GLOW_GUTTER);

    await window.evaluate(() => localStorage.removeItem('lore-server-address'));
    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('the collapse control folds the card and shrinks the window back to the pill', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Given: the card has been expanded from the pill
    await connectAndSettleToPill(window, electronApp);
    await window.locator('.morph-pill').click();
    await expect.poll(() => windowSize(electronApp)).toEqual(CARD_SIZE);

    // When: the collapse-to-pill control in the title bar is clicked
    await window.getByRole('button', { name: 'Collapse to pill' }).click();

    // Then: the card folds (CSS) and the window shrinks back to the pill
    await expect.poll(() => isExpanded(window)).toBe(false);
    await expect.poll(() => windowSize(electronApp)).toEqual(PILL_SIZE);
    await expect(window.locator('.morph-pill')).toBeVisible();

    await window.evaluate(() => localStorage.removeItem('lore-server-address'));
    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });
});
