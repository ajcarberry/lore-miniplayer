import { defineConfig } from '@playwright/test';

// Playwright runs every project when `--project` is omitted and has no
// per-project "excluded by default" flag, so electron-focus (which needs a
// visible window) is gated on detecting its explicit CLI selection.
const focusProjectRequested = process.argv.some(
  (arg, i) =>
    arg === '--project=electron-focus' ||
    (arg === '--project' && process.argv[i + 1] === 'electron-focus')
);
if (focusProjectRequested) {
  // Set before Playwright forks workers (they inherit this env) so the focus
  // specs get the visible window they assert against (see launch.ts).
  process.env['LORE_MINIPLAYER_E2E_SHOW'] = '1';
}

// --headed is a no-op for Electron; map it onto the visible-window switch so
// `pnpm test:play` keeps its "let me watch" meaning.
if (process.argv.includes('--headed')) {
  process.env['LORE_MINIPLAYER_E2E_SHOW'] = '1';
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Projects opt in below; electron-diag and electron-focus stay serial
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Total worker cap across projects. Launches are hidden and isolated (own
  // userData, HOME, and OS-assigned ports — see launch.ts), so parallel runs
  // can't interfere. CI stays at 1: 2-core runners, each worker a full
  // Electron process tree, and retries would mask oversubscription flakes.
  workers: process.env.CI ? 1 : 3,

  // Reap any suite Electron trees left by a previously aborted run before we
  // start, and guarantee none outlive the run at the end. Scoped strictly to
  // this suite's built main path — see tests/e2e/electron/support/reaper.ts.
  globalSetup: './tests/e2e/electron/support/global-setup.ts',
  globalTeardown: './tests/e2e/electron/support/global-teardown.ts',

  // The HTML report is always written; only the auto-open is gated, so a
  // concurrent or background run never pops a browser tab
  // (LORE_MINIPLAYER_E2E_OPEN_REPORT=1 opts in). CI uploads the report per-OS
  // (see ci.yml) and annotates PR diffs via the github reporter. The focus
  // run gets its own folder so it doesn't clobber the main report.
  reporter: process.env.CI
    ? [
        ['list'],
        ['github'],
        [
          'html',
          {
            open: 'never',
            outputFolder: focusProjectRequested ? 'playwright-report-focus' : 'playwright-report',
          },
        ],
      ]
    : [
        ['list'],
        [
          'html',
          {
            open: process.env['LORE_MINIPLAYER_E2E_OPEN_REPORT'] === '1' ? 'on-failure' : 'never',
            outputFolder: focusProjectRequested ? 'playwright-report-focus' : 'playwright-report',
          },
        ],
      ],

  use: {
    // Better debugging artifacts
    trace: 'retain-on-failure', // Keep trace for failed tests
    video: 'retain-on-failure', // Record video for failed tests
    screenshot: 'only-on-failure', // Screenshot on failure
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
      testIgnore: ['**/live-*.spec.ts', '**/*.diag.spec.ts', '**/window-behavior-focus.spec.ts'],
      fullyParallel: true,
      workers: process.env.CI ? 1 : 3,
      use: {},
    },
    {
      name: 'electron-live-server',
      testDir: './tests/e2e/electron',
      testMatch: '**/live-*.spec.ts',
      fullyParallel: true,
      workers: process.env.CI ? 1 : 3,
      use: {},
    },
    {
      // Launch-isolation reliability check (>=6 sequential real launches). Its
      // own project (like electron-live-server) so its real-FFI launches never
      // share a worker with the pure-UI specs. Runs as part of the default
      // `playwright test` (and `claude:pre-commit`); run it alone with
      // `playwright test --project=electron-diag`.
      name: 'electron-diag',
      testDir: './tests/e2e/electron',
      testMatch: '**/*.diag.spec.ts',
      use: {},
    },
    {
      // Needs real OS-granted focus, hence a visible window — excluded from
      // the default run by the focusProjectRequested gate above; run with
      // `playwright test --project=electron-focus`. CI runs it as its own step.
      name: 'electron-focus',
      testDir: './tests/e2e/electron',
      testMatch: focusProjectRequested ? '**/window-behavior-focus.spec.ts' : [],
      fullyParallel: false,
      workers: 1,
      use: {},
    },
  ],
});
