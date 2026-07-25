import type { Page } from '@playwright/test';
import {
  test,
  expect,
  useLiveServer,
  connect,
  addAndClone,
  collapseToPill,
  expandToCard,
  openBranchSwitcher,
  switchBranch,
  currentBranch,
  syncToLatest,
  syncToRevision,
  openHistory,
  readPillSignals,
  syncCaption,
  transportAccented,
} from './support/ui';
import { seedRepo, secondClient, sampleFiles } from './live-server.setup';

// Sync / branch / revision scenarios (WP-U5: UF, UG, UH) driven entirely through
// the support/ui helper layer against a real `loreserver`. The remote is moved
// by a teammate (secondClient) or by publishing a branch through the `lore` CLI,
// and every assertion reads an observable surface (pill notice, transport
// caption/accent, header branch). Requires the app already built in `out/`.

// Count the revision nodes currently drawn in the History timeline.
async function revisionCount(window: Page): Promise<number> {
  return window.getByRole('button', { name: /^Select revision r\d+$/ }).count();
}

// Bounded teardown (closeAppBounded) + the APP_MAIN-scoped orphan reaper (see
// launch.ts / support/reaper.ts) removed the teardown-hang failure mode and
// guarantee a clean process table at every launch. `retries: 1` REMAINS as
// documented defense-in-depth for a residual, product-side flake WP-U1b could
// not fix from the harness: `electronApp.firstWindow()` intermittently times
// out at 30s even with a verified-clean table — the launched app's main process
// never emits the `window` event (in-process Lore SDK FFI init). That needs a
// fix in src/main, not here; until then this retry keeps the suite usable.
test.describe.configure({ timeout: 120_000, retries: 1 });

test.describe('Live sync and branches', () => {
  useLiveServer();

  // UF — a teammate moves the remote ahead: the collapsed pill lights its sync
  // notice, the expanded card reads "Behind remote" with Sync accented, and a
  // Sync clears both back to their at-rest state.
  test('behind remote surfaces on the pill and card, then Sync catches up', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: user1 connects, clones repo1, and collapses to the ambient pill.
    const repo = await seedRepo(server, 'repo1', sampleFiles());
    await connect(window, server.grpcUrl);
    await addAndClone(window, electronApp, 'repo1');
    await collapseToPill(window);

    // When: a teammate commits + pushes a change, moving the remote tip ahead.
    const user2 = await secondClient(server, repo.url, 'user2');
    await user2.commitAndPush(
      { 'textures/rock-diffuse.tga': Buffer.from([0x01, 0x02, 0x03, 0x04]) },
      'teammate change'
    );

    // Then: the collapsed pill raises its sync notice (divergence -> server
    // notification -> divergence refresh pipeline; give it room).
    await expect
      .poll(async () => (await readPillSignals(window)).syncNotice, { timeout: 30_000 })
      .toBe(true);

    // And: the expanded card reads "Behind remote" with Sync as the accented
    // primary action.
    await expandToCard(window);
    await expect.poll(async () => syncCaption(window)).toBe('Behind remote');
    expect(await transportAccented(window, 'Sync')).toBe(true);

    // When: user1 syncs to the branch tip.
    await syncToLatest(window);

    // Then: the notice clears on the pill and the Sync caption returns to
    // "Current".
    await expect.poll(async () => (await readPillSignals(window)).syncNotice).toBe(false);
    await expect.poll(async () => syncCaption(window)).toBe('Current');
  });

  // UG — a teammate-published branch is listed in the switcher and switching to
  // it moves the header's current branch.
  test('a published second branch can be listed and switched to', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: repo2 seeded on main, with a second branch created + published from
    // the seeding working copy via the `lore` CLI.
    const repo = await seedRepo(server, 'repo2', sampleFiles());
    await server.lore(['branch', 'create', 'feature/lighting', '--repository', repo.workdir]);
    await server.lore(['branch', 'switch', 'feature/lighting', '--repository', repo.workdir]);
    await server.lore(['branch', 'push', 'feature/lighting', '--repository', repo.workdir]);

    // And: user1 connects and clones repo2 (lands on main).
    await connect(window, server.grpcUrl);
    await addAndClone(window, electronApp, 'repo2');
    expect(await currentBranch(window)).toBe('main');

    // When: user1 opens the branch switcher, both branches are listed.
    await openBranchSwitcher(window);
    await expect(window.getByRole('button', { name: /main/ })).toBeVisible();
    await expect(
      window.getByRole('button', { name: 'feature/lighting', exact: true })
    ).toBeVisible();

    // Close the popover so switchBranch can re-open it cleanly (the header
    // control toggles, so a second open on an already-open popover would close
    // it). Toggle it shut via the same header control rather than Escape, which
    // does not reliably reach the portaled popover here.
    await window.getByRole('button', { name: 'Switch branch' }).click();
    await expect(window.getByPlaceholder('Search branches...')).toBeHidden();

    // Then: switching to feature/lighting moves the header's current branch.
    await switchBranch(window, 'feature/lighting');
    await expect.poll(async () => currentBranch(window)).toBe('feature/lighting');
  });

  // UH — a multi-revision remote is cloned to the tip, then synced back to the
  // first revision: the working copy sits off-tip and the Sync caption reads
  // "Older revision".
  test('sync to a specific revision moves the working copy off the tip', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: repo3 seeded (r1), then a teammate pushes r2 and r3 — three
    // revisions on the remote.
    const repo = await seedRepo(server, 'repo3', sampleFiles());
    const user2 = await secondClient(server, repo.url, 'user2');
    await user2.commitAndPush(
      { 'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 256\n' },
      'r2'
    );
    await user2.commitAndPush(
      { 'meshes/cave-entrance.mesh': 'mesh-format-v1\nvertices: 512\n' },
      'r3'
    );

    // And: user1 connects and clones repo3, landing on the tip (r3) with all
    // three revisions in History.
    await connect(window, server.grpcUrl);
    await addAndClone(window, electronApp, 'repo3');
    await openHistory(window);
    await expect.poll(async () => revisionCount(window)).toBe(3);
    expect(await syncCaption(window)).toBe('Current');

    // When: user1 syncs to the first revision via the RevisionSyncModal's @N
    // shorthand.
    await syncToRevision(window, '@1');

    // Then: the working copy is off the tip — the Sync caption reads "Older
    // revision" and Sync becomes the accented primary action.
    await expect.poll(async () => syncCaption(window)).toBe('Older revision');
    expect(await transportAccented(window, 'Sync')).toBe(true);
  });
});
