import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Run serially - each test launches its own Electron instance
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker to prevent focus races between concurrent Electron windows

  // Better reporter setup for humans
  reporter: process.env.CI
    ? [['list']]
    : [['list'], ['html', { open: 'on-failure' }]],  // Auto-open on failure

  use: {
    // Better debugging artifacts
    trace: 'retain-on-failure',  // Keep trace for failed tests
    video: 'retain-on-failure',  // Record video for failed tests
    screenshot: 'only-on-failure',  // Screenshot on failure
  },

  projects: [
    {
      name: 'electron',
      testDir: './tests/e2e/electron',
      // The live-* suite runs in its own project so its worker state stays
      // out of the pure-UI specs; a shared worker delays the next spec's
      // electronApp.firstWindow() past its timeout. The P-U1 isolation-model
      // diagnostic connects to a real loreserver too, so it is likewise kept out
      // of this worker — run it explicitly (`--grep "launch isolation model"`).
      testIgnore: ['**/live-*.spec.ts', '**/*.diag.spec.ts'],
      use: {},
    },
    {
      name: 'electron-live-server',
      testDir: './tests/e2e/electron',
      testMatch: '**/live-*.spec.ts',
      use: {},
    },
    {
      // P-U1 isolation-model reliability check. Its own project (like
      // electron-live-server) so its real-FFI launches never share a worker with
      // the pure-UI specs. On-demand: `playwright test --project=electron-diag`.
      name: 'electron-diag',
      testDir: './tests/e2e/electron',
      testMatch: '**/*.diag.spec.ts',
      use: {},
    },
  ],
});
