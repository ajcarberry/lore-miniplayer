import { defineConfig } from '@playwright/test';

// electron-focus (below) exercises real OS focus/blur, which needs a visible
// window and must stay out of a bare local `playwright test` run. Playwright
// runs every project in `projects: []` whenever `--project` is omitted from
// the CLI — there's no per-project "excluded from default" flag — so the only
// way to keep this project's tests from running unrequested is to detect the
// explicit `--project=electron-focus` (or `--project electron-focus`) CLI
// selection ourselves and gate the project's testMatch on it.
const focusProjectRequested = process.argv.some(
  (arg, i) =>
    arg === '--project=electron-focus' ||
    (arg === '--project' && process.argv[i + 1] === 'electron-focus')
);
if (focusProjectRequested) {
  // See tests/e2e/electron/launch.ts: LORE_MINIPLAYER_E2E_SHOW=1 restores the
  // visible window the focus/blur and notice-dim assertions depend on. Set
  // here, before Playwright forks its worker processes (which inherit
  // process.env from this config-eval step), so `--project=electron-focus`
  // is visible wherever it's invoked from — no separate env var required.
  process.env['LORE_MINIPLAYER_E2E_SHOW'] = '1';
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Fallback for projects that don't opt into parallelism below (electron-diag's single sequential-launch test; electron-focus's real-OS-focus assertions, which stay workers:1)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Upper bound on total worker processes across all projects. Concurrent Electron
  // instances no longer race each other: since P1, test-mode windows launch hidden
  // (no dock/activation), and every launch already gets an isolated userData dir,
  // isolated HOME, and OS-assigned loreserver/CDP ports (see launch.ts) — so parallel
  // launches are independent throwaway universes. CI machines are 2-core.
  workers: process.env.CI ? 2 : 3,

  // Reap any suite Electron trees left by a previously aborted run before we
  // start, and guarantee none outlive the run at the end. Scoped strictly to
  // this suite's built main path — see tests/e2e/electron/support/reaper.ts.
  globalSetup: './tests/e2e/electron/support/global-setup.ts',
  globalTeardown: './tests/e2e/electron/support/global-teardown.ts',

  // Better reporter setup for humans. The HTML report itself is always
  // written on failure (for the trace/video/screenshot artifacts below); only
  // whether Playwright auto-opens a browser tab for it is gated. Concurrent
  // runs (two worktrees, a background run) must never pop a browser over
  // whatever the developer is doing, so `open` defaults to 'never' — set
  // LORE_MINIPLAYER_E2E_OPEN_REPORT=1 to opt back into the old on-failure pop.
  reporter: process.env.CI
    ? [['list']]
    : [
        ['list'],
        [
          'html',
          { open: process.env['LORE_MINIPLAYER_E2E_OPEN_REPORT'] === '1' ? 'on-failure' : 'never' },
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
      workers: process.env.CI ? 2 : 3,
      use: {},
    },
    {
      name: 'electron-live-server',
      testDir: './tests/e2e/electron',
      testMatch: '**/live-*.spec.ts',
      fullyParallel: true,
      workers: process.env.CI ? 2 : 3,
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
      // Focus/blur and unfocused-dim assertions need a real OS-granted window
      // focus, which in turn needs a visible window (LORE_MINIPLAYER_E2E_SHOW=1,
      // set above) — unlike every other project here, that means it can't run
      // silently as part of a developer's default `playwright test`. Kept out
      // of the default set by the focusProjectRequested gate above; run it
      // explicitly with `playwright test --project=electron-focus`. CI runs it
      // as its own step, where a visible window is expected, not a surprise on
      // someone's laptop.
      name: 'electron-focus',
      testDir: './tests/e2e/electron',
      testMatch: focusProjectRequested ? '**/window-behavior-focus.spec.ts' : [],
      fullyParallel: false,
      workers: 1,
      use: {},
    },
  ],
});
