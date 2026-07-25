import type { ElectronApplication, Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { launchApp, closeAppBounded, removeTempUserDataDir } from './launch';
import {
  startLoreServer,
  seedRepo,
  secondClient,
  sampleFiles,
  isolatedFfiHomeEnv,
  stubDirectoryPicker,
  createCloneBaseDir,
  type LoreTestServer,
} from './live-server.setup';

// Drives the real Electron app -- renderer -> IPC -> main-process service ->
// live `loreserver` -- against a hermetic server. Requires `pnpm build` first.

// The app launches its in-process Lore SDK native FFI for real. On exit the
// main process's `will-quit` runs a synchronous, unbounded `lore.shutdown()`
// that occasionally blocks past the test timeout; left unguarded that hung the
// teardown and orphaned an Electron tree that could poison a later launch's
// firstWindow(). The fixture's `closeAppBounded` races that close against a
// bound and SIGKILLs the tree on overrun, so each test gets a fresh
// isolated-HOME launch with guaranteed, bounded teardown.
const test = base.extend<{ electronApp: ElectronApplication; window: Page }>({
  electronApp: async ({}, use) => {
    const { app, userDataDir } = await launchApp(undefined, await isolatedFfiHomeEnv());
    await use(app);
    await closeAppBounded(app);
    removeTempUserDataDir(userDataDir);
  },
  window: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow());
  },
});

// Bounded teardown (closeAppBounded) removed the teardown-hang failure mode, but
// `retries: 1` REMAINS as documented defense-in-depth for a residual product-side
// flake: `electronApp.firstWindow()` intermittently times out at 30s even with a
// verified-clean process table — the launched app's main process never emits the
// `window` event (in-process Lore SDK FFI init). That needs a fix in src/main.
test.describe.configure({ timeout: 120_000, retries: 1 });

test.describe('Live server', () => {
  // The harness provisions loreserver only on darwin/linux (binaries.ts mapOs
  // throws for win32), so skip the whole block on Windows.
  test.skip(
    process.platform === 'win32',
    'lore harness provisions loreserver only on macOS/Linux (binaries.ts mapOs has no win32 case)'
  );

  let testServer: LoreTestServer | undefined;

  test.beforeAll(async () => {
    testServer = await startLoreServer();
  });

  test.afterAll(async () => {
    // harness/server.ts also stops on exit, so no loreserver is orphaned.
    await testServer?.stop();
  });

  // Fills the connect page with the harness address and expands to the card.
  async function connectToHarness(window: Page): Promise<void> {
    // The explicit `lore://` scheme is kept as entered; only bare hosts get the
    // TLS default.
    await window.getByPlaceholder('lores://lore.example.com').fill(testServer!.grpcUrl);
    await window.getByRole('button', { name: 'Connect' }).click();
    await window.locator('.morph-pill').click();
    await expect(window.getByText('On branch')).toBeVisible();
  }

  // Opens the Add Repository modal, selects `repoName` from the live server's
  // list, and picks a fresh temp base directory. The native dialog is stubbed
  // because Playwright cannot drive a real OS picker.
  async function prepareAddRepositoryForm(
    window: Page,
    app: ElectronApplication,
    repoName: string
  ): Promise<void> {
    await window.getByLabel('Repositories').click();
    await window.getByText('Add repository…').click();
    await expect(window.getByText('Define Repository')).toBeVisible();

    const search = window.getByPlaceholder('Search repositories...');
    await search.click();
    await search.fill(repoName);
    await window.getByRole('option', { name: repoName, exact: true }).click();

    const baseDir = await createCloneBaseDir();
    await stubDirectoryPicker(app, baseDir);
    await window.getByLabel('Select base directory').click();

    await expect(window.getByRole('button', { name: 'Add & Clone Repository' })).toBeEnabled();
  }

  // Submits the filled form and waits for the real clone to finish.
  async function submitAddRepositoryForm(window: Page): Promise<void> {
    await window.getByRole('button', { name: 'Add & Clone Repository' }).click();
    await expect(window.getByText('Define Repository')).not.toBeVisible({ timeout: 30_000 });
  }

  async function addAndCloneRepository(
    window: Page,
    app: ElectronApplication,
    repoName: string
  ): Promise<void> {
    await prepareAddRepositoryForm(window, app, repoName);
    await submitAddRepositoryForm(window);
  }

  // The repository name renders in two places while the card is expanded (header
  // eyebrow and the always-mounted pill), so a bare getByText is ambiguous. Scope
  // to the header button, which carries a stable aria-label.
  function repoHeaderName(window: Page, repoName: string): ReturnType<Page['getByText']> {
    return window.getByRole('button', { name: 'Switch branch' }).getByText(repoName, {
      exact: true,
    });
  }

  test('clone a real repository into the card, then open an empty one', async ({
    electronApp,
    window,
  }) => {
    const repoName = 'repo1';
    const emptyRepoName = 'repo4';
    await seedRepo(testServer!, repoName, sampleFiles());
    await testServer!.createRepo(emptyRepoName); // no revisions

    // Both narratives share one launched session -- cloning a real repository,
    // then opening a brand-new empty one -- like a user adding a second
    // repository without relaunching.

    // Given: user1 connects to the server
    await connectToHarness(window);

    // When: user1 picks repo1 from the server's repository list and
    // clones it
    await addAndCloneRepository(window, electronApp, repoName);

    // Then: the UI has left the connect page and the card shows the cloned
    // repository -- its name in the header eyebrow and a normal transport row.
    await expect(repoHeaderName(window, repoName)).toBeVisible();
    await expect(window.getByText('Sync', { exact: true })).toBeVisible();
    await expect(window.getByText('No history yet')).not.toBeVisible();

    // When: user1 also adds a brand-new empty repo
    await addAndCloneRepository(window, electronApp, emptyRepoName);

    // Then: the card shows the empty repository cloned onto disk, with a plain
    // "no history yet" state rather than a broken graph or stuck loader.
    await expect(repoHeaderName(window, emptyRepoName)).toBeVisible();
    await expect(window.getByText('Sync', { exact: true })).toBeVisible();
    await expect(window.getByText('No history yet')).toBeVisible();
    await expect(window.getByLabel('Loading history')).not.toBeVisible();

    // And: the window is still responsive -- the repository picker still opens
    // and lists both repositories. Each row is a button labeled with the repo
    // name, so the lookup is role-scoped.
    await window.getByLabel('Repositories').click();
    await expect(window.getByText('Add repository…')).toBeVisible();
    await expect(window.getByRole('button', { name: repoName, exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: emptyRepoName, exact: true })).toBeVisible();
  });

  test('a teammate push surfaces the sync-needed pill, and clears on sync', async ({
    electronApp,
    window,
  }) => {
    const repoName = 'repo2';
    const repo = await seedRepo(testServer!, repoName, sampleFiles());

    await connectToHarness(window);
    await addAndCloneRepository(window, electronApp, repoName);
    await expect(repoHeaderName(window, repoName)).toBeVisible();

    // Collapse back to the ambient pill. The title bar's control is used rather
    // than re-clicking .morph-pill: while the card is expanded it covers the
    // pill and intercepts pointer events at that position.
    await window.getByRole('button', { name: 'Collapse to pill' }).click();
    await expect(window.locator('.morph-root')).toHaveAttribute('data-expanded', 'false');

    const pillBar = window.locator('.morph-pill-bar');
    await expect(pillBar).toBeVisible();
    await expect(pillBar).not.toHaveAttribute('data-notice', 'sync');

    // The notice/dim interplay only matters when the window isn't focused, and
    // win.blur() is a request the OS may refuse, so the dim half is skipped
    // rather than falsely failed when blur isn't granted.
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.blur();
    });
    const canObserveDimming = await electronApp.evaluate(
      async ({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0]!.isFocused()
    );

    // Give the repository's just-established notification subscription (an
    // unawaited effect with no UI signal) a moment to reach the server before
    // the push, otherwise the push could race ahead of it.
    await window.waitForTimeout(500);

    // When: user2 (a second client) pushes a change to the same branch.
    const user2 = await secondClient(testServer!, repo.url, 'user2');
    await user2.commitAndPush(
      { 'textures/rock-diffuse.tga': Buffer.from([0x54, 0x52, 0x55, 0x45, 0xaa, 0x01]) },
      'Lighting fix'
    );

    // Then: the collapsed pill picks up the real notice pulse through the full
    // divergence -> notification -> pill pipeline.
    await expect(pillBar).toHaveAttribute('data-notice', 'sync', { timeout: 20_000 });

    if (canObserveDimming) {
      // And: the window skips its unfocused dim while the notice is active
      await expect
        .poll(() =>
          electronApp.evaluate(async ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.getOpacity()
          )
        )
        .toBe(1.0);
    } else {
      test.info().annotations.push({
        type: 'not-observable',
        description:
          'OS did not grant this window a real blur, so the unfocused-dim-suspension half of U2 could not be observed here.',
      });
    }

    // When: user1 syncs
    await window.locator('.morph-pill').click(); // re-expand
    await window.getByText('Sync', { exact: true }).click();

    // Then: the notice clears
    await expect(pillBar).not.toHaveAttribute('data-notice', 'sync', { timeout: 20_000 });
  });

  test('cloning a heavy asset streams real progress events to completion', async ({
    electronApp,
    window,
  }) => {
    const repoName = 'repo3';
    // Several multi-MB binary assets (~24MB total).
    const heavyAssetFiles = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `textures/heavy-diffuse-${index}.tga`,
        Buffer.alloc(3 * 1024 * 1024, 0x41 + index),
      ])
    );
    await seedRepo(testServer!, repoName, heavyAssetFiles);

    await connectToHarness(window);
    await prepareAddRepositoryForm(window, electronApp, repoName);

    // Record every percent the real clone-progress channel delivers to the
    // renderer -- the same bridge subscription that drives the visible Progress
    // bar -- captured directly so the assertion doesn't race Playwright's DOM
    // polling. These evaluate callbacks run in the page, so they reach its
    // global via globalThis.
    await window.evaluate(() => {
      const samples: number[] = [];
      (
        globalThis.window as unknown as { __cloneProgressSamples: number[] }
      ).__cloneProgressSamples = samples;
      globalThis.window.electronAPI.lore.repository.onCloneProgress((payload: unknown) => {
        const percent = (payload as { percent?: unknown }).percent;
        if (typeof percent === 'number') {
          samples.push(percent);
        }
      });
    });

    await submitAddRepositoryForm(window);

    const samples = await window.evaluate(
      () =>
        (globalThis.window as unknown as { __cloneProgressSamples: number[] })
          .__cloneProgressSamples
    );

    // Then: the repository landed, and the channel streamed multiple real events
    // (discovery, then completion) rather than a single opaque "done" signal.
    await expect(repoHeaderName(window, repoName)).toBeVisible();
    expect(
      samples.length,
      `expected multiple clone-progress ticks, got: ${JSON.stringify(samples)}`
    ).toBeGreaterThan(1);
    expect(
      samples.at(-1),
      `expected the final tick to reach 100%, got: ${JSON.stringify(samples)}`
    ).toBe(100);

    // A loopback clone reports only discovery (0%) and completion (100%)
    // checkpoints, with the byte transfer finishing between them in under
    // 100ms, so there is no intermediate 1-99% tick to observe. This does not
    // assert an advancing bar.
  });
});
