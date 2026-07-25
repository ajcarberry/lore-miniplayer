import { basename } from 'node:path';
import {
  test,
  expect,
  useLiveServer,
  connect,
  addAndClone,
  addExisting,
  openRepositoryPicker,
  selectRepository,
  repoHeaderName,
  historyEmpty,
} from './support/ui';
import { seedRepo, secondClient, sampleFiles } from './live-server.setup';

// Repository-lifecycle scenarios driven entirely through the support/ui helper
// layer against a real `loreserver`. UA is the WP-U2 smoke that proves the
// helper module + fixture; WP-U3 adds UB/UC here. Requires `pnpm build` first.

// Bounded teardown (closeAppBounded) + the APP_MAIN-scoped orphan reaper (see
// launch.ts / support/reaper.ts) removed the teardown-hang failure mode and
// guarantee a clean process table at every launch. `retries: 1` REMAINS as
// documented defense-in-depth for a residual, product-side flake WP-U1b could
// not fix from the harness: `electronApp.firstWindow()` intermittently times
// out at 30s even with a verified-clean table — the launched app's main process
// never emits the `window` event (in-process Lore SDK FFI init). That needs a
// fix in src/main, not here; until then this retry keeps the suite usable.
test.describe.configure({ timeout: 120_000, retries: 1 });

test.describe('Live repositories', () => {
  useLiveServer();

  // UA — clone a seeded repository from the server's remote list.
  test('clone from the remote list lands the repository in the card', async ({
    window,
    electronApp,
    server,
  }) => {
    const repo1 = 'repo1';
    await seedRepo(server, repo1, sampleFiles());

    // Given: user1 connects to the live server.
    await connect(window, server.grpcUrl);

    // When: user1 picks repo1 from the remote list and clones it through the
    // Add Repository flow.
    await addAndClone(window, electronApp, repo1);

    // Then: the card shows the cloned repository — its name in the header
    // eyebrow, a normal transport row, and real history (not the empty state).
    await expect(repoHeaderName(window, repo1)).toBeVisible();
    await expect(window.getByText('Sync', { exact: true })).toBeVisible();
    await expect(historyEmpty(window)).not.toBeVisible();
  });

  // UB — add a workspace that already exists on disk (a real Lore working copy).
  test('adding an existing on-disk workspace tracks it without a clone slot', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: a seeded server repo with a real on-disk Lore working copy (cloned
    // via the `lore` CLI by secondClient). The card's header name comes from the
    // on-disk folder basename, so the server repo name (kept unique across this
    // file's shared server) is immaterial to the assertions.
    const repo = await seedRepo(server, 'repo2', sampleFiles());
    const existing = await secondClient(server, repo.url, 'user1');
    const workspaceName = basename(existing.workdir);

    // When: user1 connects and adds the existing directory. The picker is stubbed
    // to it; checkStatus reports isLoreRepo, so the modal flips to existing-mode
    // and submits as "Add Existing Repository".
    await connect(window, server.grpcUrl);
    await addExisting(window, electronApp, existing.workdir);

    // Then: the card tracks the on-disk workspace by its folder basename, shows
    // the Sync transport cell, and offers Push (not Clone) — it is already on disk.
    await expect(repoHeaderName(window, workspaceName)).toBeVisible();
    await expect(window.getByText('Sync', { exact: true })).toBeVisible();
    await expect(window.getByText('Clone', { exact: true })).not.toBeVisible();
  });

  // UC — hold multiple workspaces and switch the active one via the picker.
  test('multiple cloned workspaces can be listed and switched between', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: two seeded server repos, both cloned through the Add flow. Names are
    // unique across this file's shared per-file server (repo1/repo2 are already
    // taken by UA/UB). The app auto-selects the most recently added (repo4), so
    // repo3 is the observable target to switch to.
    await seedRepo(server, 'repo3', sampleFiles());
    await seedRepo(server, 'repo4', sampleFiles());

    await connect(window, server.grpcUrl);
    await addAndClone(window, electronApp, 'repo3');
    await addAndClone(window, electronApp, 'repo4');

    // When: the repositories picker is opened, both workspaces are listed.
    await openRepositoryPicker(window);
    await expect(window.getByRole('button', { name: 'repo3', exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'repo4', exact: true })).toBeVisible();
    // Close the popover so selectRepository can re-open it cleanly (the target
    // toggles, so a second open on an already-open popover would close it).
    await window.keyboard.press('Escape');

    // Then: selecting repo3 switches the active workspace — the header name is
    // repo3 and its picker row is marked active.
    await selectRepository(window, 'repo3');
    await expect(repoHeaderName(window, 'repo3')).toBeVisible();

    // The in-dropdown select does not deterministically leave the picker open —
    // the repo-switch re-render can dismiss it — so normalize to a known-open
    // state (fully close, then re-open) before reading the active marker rather
    // than racing whatever state the select left behind.
    await window.keyboard.press('Escape');
    await expect(window.getByText('Add repository…')).toBeHidden();
    await openRepositoryPicker(window);
    await expect(window.getByText('Add repository…')).toBeVisible();
    const repo3Row = window
      .getByRole('button', { name: 'repo3', exact: true })
      .locator('xpath=ancestor::*[@data-active][1]');
    await expect(repo3Row).toHaveAttribute('data-active', 'true');
  });
});
