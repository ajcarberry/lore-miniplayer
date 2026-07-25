import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  test,
  expect,
  useLiveServer,
  connect,
  addAndClone,
  writeInClone,
  refreshWorkingSet,
  openWorkingSet,
  workingSetRow,
  resetWorkspace,
  readPillSignals,
  openRepositoryPicker,
  deleteRepository,
  stubOpenExternals,
} from './support/ui';
import { seedRepo, sampleFiles } from './live-server.setup';

// Reset / repo-management / shortcut scenarios (WP-U6: UI, UK, UL) driven through
// the support/ui helper layer against a real `loreserver`. Each test uses a
// UNIQUE repo name (the loreserver is shared across the describe). Requires
// `pnpm build` first.

// `retries: 1` is documented defense-in-depth for a residual product-side flake
// (see live-working-set.spec.ts): `electronApp.firstWindow()` intermittently
// times out even with a clean process table because the launched app's main
// process never emits the `window` event (in-process Lore SDK FFI init). One
// firstWindow-hang retry is acceptable; a deterministic failure is not.
test.describe.configure({ timeout: 120_000, retries: 1 });

test.describe('Live reset and repository management', () => {
  useLiveServer();

  // UI — reset a dirty workspace: an on-disk scratch edit surfaces as dirty
  // (working set + pill uncommitted glyph), and Reset discards it back to clean.
  test('reset discards a dirty workspace', async ({ window, electronApp, server }) => {
    // Given: user1 connects and clones a seeded repo, then scratches a tracked
    // mesh on disk and forces the card to re-read status.
    await seedRepo(server, 'reset-repo', sampleFiles());
    await connect(window, server.grpcUrl);
    const { clonePath } = await addAndClone(window, electronApp, 'reset-repo');

    await writeInClone(clonePath, { 'meshes/cave-entrance.mesh': 'SCRATCH EDIT\n' });
    await refreshWorkingSet(window);
    await openWorkingSet(window);

    // Then: the edit shows in the working set and the pill flags uncommitted.
    await expect(workingSetRow(window, 'meshes/cave-entrance.mesh')).toBeVisible();
    await expect.poll(async () => (await readPillSignals(window)).uncommitted).toBe(true);

    // When: user1 resets the workspace and re-reads status.
    await resetWorkspace(window);
    await refreshWorkingSet(window);

    // Then: the workspace is clean — the file leaves the working set, the pill
    // clears, and the on-disk edit is discarded (the seeded content is back).
    await expect(workingSetRow(window, 'meshes/cave-entrance.mesh')).not.toBeVisible();
    await expect.poll(async () => (await readPillSignals(window)).uncommitted).toBe(false);
    const restored = await readFile(join(clonePath, 'meshes/cave-entrance.mesh'), 'utf8');
    expect(restored).not.toContain('SCRATCH EDIT');
  });

  // UK — remove a repository from the app: after adding, deleteRepository takes
  // it out of the app's picker list (it stays on the server).
  test('removing a repository takes it out of the app picker', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: user1 connects, clones a repo, and sees it in the picker.
    await seedRepo(server, 'mgmt-repo', sampleFiles());
    await connect(window, server.grpcUrl);
    await addAndClone(window, electronApp, 'mgmt-repo');

    await openRepositoryPicker(window);
    await expect(window.getByLabel('Edit mgmt-repo')).toBeVisible();

    // When: user1 removes it from the app.
    await deleteRepository(window, 'mgmt-repo');

    // Then: it no longer appears in the repo picker.
    await openRepositoryPicker(window);
    await expect(window.getByLabel('Edit mgmt-repo')).toHaveCount(0);
  });

  // UL — open-in-explorer / open-terminal shortcuts: both footer shortcuts fire
  // their IPC exactly once with the cloned repo's on-disk path. Stubbed because
  // they launch external apps — we assert the invocation, not a real window.
  test('footer shortcuts invoke open-in-explorer and open-terminal with the clone path', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: user1 connects and clones a repo; the external launchers are stubbed
    // BEFORE any click so the captures are complete.
    await seedRepo(server, 'shortcut-repo', sampleFiles());
    await connect(window, server.grpcUrl);
    const { clonePath } = await addAndClone(window, electronApp, 'shortcut-repo');
    const externals = await stubOpenExternals(electronApp);

    // When: user1 clicks both footer shortcuts.
    await window.getByLabel('Open in File Explorer').click();
    await window.getByLabel('Open Terminal here').click();

    // Then: each stub was invoked once, with the cloned repo's path on disk.
    await expect.poll(async () => externals.explorerCalls()).toEqual([clonePath]);
    await expect.poll(async () => externals.terminalCalls()).toEqual([clonePath]);
  });
});
