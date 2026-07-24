import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
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
// card-anatomy.spec.ts's doc comments for why they avoid it), these specs
// start a real hermetic server via tests/integration/harness/server.ts and
// feed its plaintext `lore://` address straight to the running app.
//
// Requires `pnpm build` first, same as every other Electron e2e spec.
//
// `retries: 1` is scoped to just this describe block (not playwright.config.ts,
// which stays untouched at its default 0 locally / 2 in CI): launching this
// app spins up its in-process Lore SDK native FFI for real, and that launch
// is occasionally, non-deterministically slow to produce Playwright's
// "window" event under this harness -- confirmed via `ps` that the OS
// process spawns and sits idle rather than crashing, and that a fresh retry
// of the exact same launch reliably succeeds. This is environment launch
// flakiness, not app behavior -- nothing about *what's asserted* is retried
// into passing.
test.describe.configure({ timeout: 120_000, retries: 1 });

test.describe('Live server (WP6 U1-U4)', () => {
  // The harness's binary provisioning (tests/integration/harness/binaries.ts's
  // mapOs) only resolves Lore release assets for darwin/linux -- it throws
  // for win32. CI (WP7) runs this e2e step on macOS AND Windows, so this
  // whole block must skip there rather than let beforeAll's startLoreServer()
  // throw and fail the run; the platform-agnostic specs alongside it keep
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
    // Belt-and-suspenders with harness/server.ts's own exit safety net --
    // this is the graceful path so no loreserver is ever left orphaned.
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

  // U1 and U4 share one Electron session (see the "why one app session"
  // comment at the top of the test body): both are otherwise-independent
  // narratives -- Maya connecting and cloning a real repository, and Maya
  // opening a brand-new empty one -- realistically chained as one sitting,
  // exactly like a user adding a second repository without relaunching.
  test('U1+U4: clone a real repository into the card, then open an empty one', async () => {
    const repoName = 'u1-island-caves';
    const emptyRepoName = 'u4-empty-repo';
    await seedRepo(testServer!, repoName, islandCavesFiles());
    await testServer!.createRepo(emptyRepoName); // no revisions

    // Why one app session: this Electron app launches its in-process Lore
    // SDK native FFI for real, and empirically the 4th such real launch
    // within one Playwright worker process hangs indefinitely on
    // `firstWindow()` -- confirmed via `ps` that the OS process spawns and
    // stays alive (idle, no crash), so this is Electron/Node/FFI launch
    // plumbing wedging under this harness, not an application bug (a
    // subsequent launch always recovers). Three real launches per file is
    // reliably clean, so U1 and U4 -- which don't need independent app
    // instances to be faithfully tested -- share one, keeping this file at 3.
    const { app: electronApp, userDataDir } = await launchApp(
      undefined,
      await isolatedFfiHomeEnv()
    );
    const window = await electronApp.firstWindow();

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
    await expect(window.getByText('Commit', { exact: true })).toBeVisible();
    await expect(window.getByText('Push', { exact: true })).toBeVisible();
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

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('U2: a teammate push surfaces the sync-needed pill, and clears on sync', async () => {
    const repoName = 'u2-sync-pill';
    const repo = await seedRepo(testServer!, repoName, islandCavesFiles());

    const { app: electronApp, userDataDir } = await launchApp(
      undefined,
      await isolatedFfiHomeEnv()
    );
    const window = await electronApp.firstWindow();

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

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('U3: cloning a heavy asset streams real progress events to completion', async () => {
    const repoName = 'u3-heavy-asset';
    // Several multi-MB binary assets (~24MB total).
    const heavyAssetFiles = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `textures/heavy-diffuse-${index}.tga`,
        Buffer.alloc(3 * 1024 * 1024, 0x41 + index),
      ])
    );
    await seedRepo(testServer!, repoName, heavyAssetFiles);

    const { app: electronApp, userDataDir } = await launchApp(
      undefined,
      await isolatedFfiHomeEnv()
    );
    const window = await electronApp.firstWindow();

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

    // NOT OBSERVABLE HERE, and why: U3 also wants the visible bar advancing
    // through intermediate percentages (not "frozen/instant"). Probed
    // directly against this harness (see the SDK's raw REPOSITORY_CLONE_
    // PROGRESS `count` payloads for this same clone): a 24-120MB local
    // clone over loopback reports exactly three checkpoints -- discovery
    // start (0%), discovery complete (0%), full completion (100%) -- with
    // the whole byte transfer completing between the second and third
    // checkpoint in under 100ms, regardless of payload size tried (24MB up
    // to 120MB). There is no intermediate 1-99% tick to observe on this
    // harness: the SDK only reports byte progress at file/discovery
    // boundaries, and a same-machine loopback transfer finishes before a
    // second boundary can land mid-transfer. Reproducing a genuinely
    // advancing bar would need either real network latency (unavailable in
    // this hermetic harness) or a payload large enough to keep the transfer
    // running for multiple seconds, which isn't a reasonable tradeoff for
    // this suite's runtime.

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });
});
