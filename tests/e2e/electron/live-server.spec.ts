import type { ElectronApplication, Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';
import {
  startLoreServer,
  seedRepo,
  secondClient,
  islandCavesFiles,
  isolatedFfiHomeEnv,
  stubDirectoryPicker,
  createCloneBaseDir,
  type LoreTestServer,
} from './live-server.setup';

// WP6 (see .claude/mission/spec.md's "Scenarios (WP4-WP6)" -> U1-U4): the UI
// subset that drives the REAL Electron app -- renderer -> IPC -> main-process
// service -> live `loreserver` -- through the states most likely to trip the
// interface. Unlike the rest of tests/e2e (see launch.ts and
// card-anatomy.spec.ts for why they avoid it), these start a real hermetic
// server via tests/integration/harness/server.ts and feed its plaintext
// `lore://` address straight to the running app. Requires `pnpm build` first,
// like every other Electron e2e spec.

// Per-test launch of the real app (fresh isolated FFI HOME) with guaranteed
// teardown. The app spins up its in-process Lore SDK native FFI for real, and
// that launch is occasionally, non-deterministically slow to produce the
// `window` event under this harness -- confirmed via `ps` that the OS process
// spawns and sits idle rather than crashing, and that a fresh retry reliably
// succeeds. This launch plumbing (never *what's asserted*) drives two things:
// `retries: 1` below, and an empirical ceiling of ~3 real launches per worker
// (the 4th `firstWindow()` hangs indefinitely), which is why U1 and U4 share
// one launch in a single test.
const test = base.extend<{ electronApp: ElectronApplication; window: Page }>({
  electronApp: async ({}, use) => {
    const { app, userDataDir } = await launchApp(undefined, await isolatedFfiHomeEnv());
    await use(app);
    await app.close();
    removeTempUserDataDir(userDataDir);
  },
  window: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow());
  },
});

// Scoped to just this file (playwright.config.ts stays at its default 0 local /
// 2 CI) -- see the launch-flakiness note above.
test.describe.configure({ timeout: 120_000, retries: 1 });

test.describe('Live server (WP6 U1-U4)', () => {
  // The harness provisions Lore release assets only for darwin/linux
  // (binaries.ts mapOs throws for win32), and CI runs this step on macOS AND
  // Windows, so skip the whole block there rather than let beforeAll's
  // startLoreServer() throw. The platform-agnostic specs alongside it keep
  // running on Windows untouched.
  test.skip(
    process.platform === 'win32',
    'lore harness provisions loreserver only on macOS/Linux (binaries.ts mapOs has no win32 case)'
  );

  let testServer: LoreTestServer | undefined;

  test.beforeAll(async () => {
    testServer = await startLoreServer();
  });

  test.afterAll(async () => {
    // Graceful path; harness/server.ts also has its own exit safety net, so no
    // loreserver is ever left orphaned.
    await testServer?.stop();
  });

  // Fills the connect page with the harness server's address and expands
  // straight to the (repository-less) card -- shared first step for every
  // scenario below.
  async function connectToHarness(window: Page): Promise<void> {
    // Explicit `lore://` scheme (plaintext, matching the harness) is kept
    // as-entered by useServerConnection -- only bare hosts get the TLS
    // default, see connect-page.spec.ts.
    await window.getByPlaceholder('lores://lore.example.com').fill(testServer!.grpcUrl);
    await window.getByRole('button', { name: 'Connect' }).click();
    await window.locator('.morph-pill').click();
    await expect(window.getByText('On branch')).toBeVisible();
  }

  // Opens the Add Repository modal, searches the live server's repository
  // list for `repoName`, selects it, and picks a fresh temp folder as the
  // base directory (via a stubbed native dialog -- Playwright can't drive a
  // real OS picker). Leaves the submit button enabled and ready to click, so
  // callers needing to instrument the clone (U3) can hook in before
  // submitting.
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

  // Submits the (already-filled) Add Repository form and waits for the real
  // clone to finish and the modal to close.
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

  // The selected repository's name renders in two places at once whenever
  // the card is expanded -- the header eyebrow (PlayerHeader.tsx) AND the
  // always-mounted pill (Pill.tsx) -- so a bare getByText(repoName) is a
  // strict-mode violation. Scope to the header, which carries a stable
  // aria-label regardless of its (changing) visible text.
  function repoHeaderName(window: Page, repoName: string): ReturnType<Page['getByText']> {
    return window.getByRole('button', { name: 'Switch branch' }).getByText(repoName, {
      exact: true,
    });
  }

  test('U1+U4: clone a real repository into the card, then open an empty one', async ({
    electronApp,
    window,
  }) => {
    const repoName = 'u1-island-caves';
    const emptyRepoName = 'u4-empty-repo';
    await seedRepo(testServer!, repoName, islandCavesFiles());
    await testServer!.createRepo(emptyRepoName); // no revisions

    // U1 and U4 share this one launched session (see the launch note above):
    // two otherwise-independent narratives -- Maya cloning a real repository,
    // then opening a brand-new empty one -- realistically chained as one
    // sitting, exactly like a user adding a second repository without
    // relaunching.

    // Given: Maya connects to the live studio server
    await connectToHarness(window);

    // U1 -- When: she picks island-caves from the server's real repository
    // list and clones it
    await addAndCloneRepository(window, electronApp, repoName);

    // Then: the UI has moved off the connect page and the repository card
    // shows the real cloned repository -- its name in the header eyebrow,
    // and the normal (not "not on disk yet") transport row.
    await expect(repoHeaderName(window, repoName)).toBeVisible();
    await expect(window.getByText('Sync', { exact: true })).toBeVisible();
    await expect(window.getByText('No history yet')).not.toBeVisible();

    // U4 -- When: Maya also adds island-caves-2, a brand-new empty repo
    await addAndCloneRepository(window, electronApp, emptyRepoName);

    // Then: the card shows the empty repository -- cloned onto disk (normal
    // transport, not "Clone"), with a plain "no history yet" state rather
    // than a broken/blank graph or a stuck loader.
    await expect(repoHeaderName(window, emptyRepoName)).toBeVisible();
    await expect(window.getByText('Sync', { exact: true })).toBeVisible();
    await expect(window.getByText('No history yet')).toBeVisible();
    await expect(window.getByLabel('Loading history')).not.toBeVisible();

    // And: the window is still alive and responsive (no crash) -- the
    // repository picker still opens normally and lists both repositories.
    // Each repository row in the popover is itself a button labeled with
    // the repo name -- a role-scoped lookup, since the name also renders in
    // the header eyebrow and the pill at the same time (see repoHeaderName).
    await window.getByLabel('Repositories').click();
    await expect(window.getByText('Add repository…')).toBeVisible();
    await expect(window.getByRole('button', { name: repoName, exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: emptyRepoName, exact: true })).toBeVisible();
  });

  test('U2: a teammate push surfaces the sync-needed pill, and clears on sync', async ({
    electronApp,
    window,
  }) => {
    const repoName = 'u2-sync-pill';
    const repo = await seedRepo(testServer!, repoName, islandCavesFiles());

    await connectToHarness(window);
    await addAndCloneRepository(window, electronApp, repoName);
    await expect(repoHeaderName(window, repoName)).toBeVisible();

    // Collapse back to the ambient pill -- the surface U2 actually targets.
    // The title bar's dedicated control is used rather than re-clicking
    // .morph-pill: while the card is expanded, the pill sits underneath it
    // and the card's own content intercepts pointer events at that position.
    await window.getByRole('button', { name: 'Collapse to pill' }).click();
    await expect(window.locator('.morph-root')).toHaveAttribute('data-expanded', 'false');

    const pillBar = window.locator('.morph-pill-bar');
    await expect(pillBar).toBeVisible();
    await expect(pillBar).not.toHaveAttribute('data-notice', 'sync');

    // Try for a real unfocused window -- the notice/dim interplay only
    // matters when the window isn't focused. win.blur() is a request, not a
    // guarantee (window-behavior.spec.ts hits the same OS/sandbox limit), so
    // the dim-suspension half of this assertion is skipped rather than
    // falsely failed when the OS won't grant it.
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.blur();
    });
    const canObserveDimming = await electronApp.evaluate(
      async ({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0]!.isFocused()
    );

    // Give the repository's just-established notification subscription (an
    // unawaited effect with no UI signal of its own) a moment to reach the
    // server before Devin pushes -- otherwise the push could race ahead of it.
    await window.waitForTimeout(500);

    // When: Devin (a second client/working copy) pushes a change to the same
    // branch out from under Maya.
    const devin = await secondClient(testServer!, repo.url, 'devin-u2');
    await devin.commitAndPush(
      { 'textures/rock-diffuse.tga': Buffer.from([0x54, 0x52, 0x55, 0x45, 0xaa, 0x01]) },
      'Lighting fix'
    );

    // Then: the collapsed pill picks up the real notice pulse through the
    // full divergence -> notification -> pill pipeline (no manual IPC poke,
    // unlike window-behavior.spec.ts's setNoticeActive plumbing test).
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

    // When: Maya syncs
    await window.locator('.morph-pill').click(); // re-expand
    await window.getByText('Sync', { exact: true }).click();

    // Then: the notice clears
    await expect(pillBar).not.toHaveAttribute('data-notice', 'sync', { timeout: 20_000 });
  });

  test('U3: cloning a heavy asset streams real progress events to completion', async ({
    electronApp,
    window,
  }) => {
    const repoName = 'u3-heavy-asset';
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
    // renderer -- the exact bridge subscription useRepositorySubmission's
    // onCloneProgress hook uses to drive the visible Progress bar/button
    // label (AddRepositoryModal.tsx), captured directly so "advancing, not
    // frozen/instant" doesn't depend on winning a race against Playwright's
    // DOM-polling interval.
    // `window` here is the Playwright Page (see connectToHarness's param),
    // so these evaluate callbacks reach the page's global via globalThis
    // rather than shadowing it with that same name (see card-anatomy.spec.ts).
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

    // Then: the repository actually landed, and the clone-progress channel
    // genuinely streamed multiple real events over its lifetime (discovery,
    // then completion) rather than the renderer receiving a single opaque
    // "done" signal with no progress plumbing behind it.
    await expect(repoHeaderName(window, repoName)).toBeVisible();
    expect(
      samples.length,
      `expected multiple clone-progress ticks, got: ${JSON.stringify(samples)}`
    ).toBeGreaterThan(1);
    expect(
      samples.at(-1),
      `expected the final tick to reach 100%, got: ${JSON.stringify(samples)}`
    ).toBe(100);

    // Intentionally NOT asserted: a visibly advancing 1-99% bar. Probed
    // directly against this harness, a 24-120MB local clone over loopback
    // reports exactly three checkpoints -- discovery start (0%), discovery
    // complete (0%), full completion (100%) -- with the whole byte transfer
    // finishing between the last two in under 100ms. There is no intermediate
    // tick to observe here; reproducing one would need real network latency
    // or a payload large enough to run for seconds, neither worth this suite's
    // runtime.
  });
});
