import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';

// Requires `pnpm build` first — launches the built app at out/main/index.js.
test.describe('Connect Page', () => {
  test('accepts a server address and enters the repository card', async () => {
    // Given: The app is launched against a fresh, isolated profile (no stored
    // server address) — see ./launch for why this never touches the real
    // user's userData.
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    // Then: The connect page shows a server address input and a disabled button
    const addressInput = window.getByPlaceholder('lores://lore.example.com');
    await expect(addressInput).toBeVisible();
    const connectButton = window.getByRole('button', { name: 'Connect' });
    await expect(connectButton).toBeDisabled();

    // When: A server address is entered and Connect is clicked
    await addressInput.fill('lore.example.com');
    await expect(connectButton).toBeEnabled();
    await connectButton.click();

    // And: The now-connected pill is clicked to unfold the full card (connecting
    // collapses straight to the pill — see morph.spec.ts — so the card's
    // contents only render once the pill is clicked)
    await window.locator('.morph-pill').click();

    // Then: The card is shown, with the branch header visible
    await expect(window.getByText('On branch')).toBeVisible();

    // And: The address is persisted for the next launch, normalized to TLS
    const stored = await window.evaluate(() => localStorage.getItem('lore-server-address'));
    expect(stored).toBe('lores://lore.example.com');

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });
});
