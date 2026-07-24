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
      // The live-server suite drives a real loreserver + repeatedly launches
      // and closes the app in one file; run it in its own project (below) so
      // its worker state never bleeds into the pure-UI specs — sharing a worker
      // delays the next spec's electronApp.firstWindow() past its timeout.
      testIgnore: '**/live-server.spec.ts',
      use: {},
    },
    {
      name: 'electron-live-server',
      testDir: './tests/e2e/electron',
      testMatch: '**/live-server.spec.ts',
      use: {},
    },
  ],
});
