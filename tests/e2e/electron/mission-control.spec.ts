import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';
import { createOfflineLoreRepo, removeOfflineLoreRepo } from './offline-repo';
import type { LaunchedApp } from './launch';

// Requires `pnpm build` first — launches the built app at out/main/index.js.
//
// No live Lore server exists in this environment. Repository *registration*
// needs no server at all — "add existing repository" only checks for a
// `.lore/` marker on disk (src/main/services/lore-repository.ts's
// checkRepositoryStatus) and `repository:create` is a local config write, not
// an SDK call — so these specs bootstrap a real, purely-local Lore repo
// offline (see ./offline-repo.ts; P1 finding: `repositoryCreate` works fully
// offline) and add it via the "existing repository" path. The native
// directory-picker dialog is stubbed via `electronApp.evaluate` (a standard
// Playwright-Electron technique for `dialog.showOpenDialog`), so no real OS
// dialog needs to open.
//
// Workspace *provisioning* is NOT exercised here beyond the modal's own input
// validation: a real provisioning clone needs a shared-store clone against a
// live server (P1 finding b — offline clone is blocked), so submitting the
// provision form is out of reach in this environment. This suite instead
// covers the cancel path, matching the packet's brief.
//
// Since the U3 unification, Mission Control composes the anchor workspace
// (the card-view checkout itself) as a listed member alongside any
// provisioned worktrees, so a repository with zero provisioned worktrees is
// NOT the empty "no workspaces" state — it shows the anchor as the sole idle
// member, marked active.

async function connectAndExpand(window: Page): Promise<void> {
  await window.getByPlaceholder('lores://lore.example.com').fill('lore.example.com');
  await window.getByRole('button', { name: 'Connect' }).click();
  await window.locator('.morph-pill').click();
  await expect(window.getByText('On branch')).toBeVisible();
}

async function addExistingRepository(
  electronApp: LaunchedApp['app'],
  window: Page,
  repoDir: string
): Promise<void> {
  // Stub the native directory picker to return the offline fixture repo,
  // rather than opening a real OS dialog.
  await electronApp.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [dir],
    })) as typeof dialog.showOpenDialog;
  }, repoDir);

  await window.getByLabel('Workspaces').click();
  await window.getByText('Add workspace…').click();
  await expect(window.getByText('Define Workspace')).toBeVisible();

  await window.getByLabel('Select base directory').click();
  // Recognized as an existing Lore repo (the `.lore/` marker P1 bootstrapped),
  // so the remote-repository picker (which would need a live server) is
  // skipped entirely.
  await expect(window.getByText('Selected directory contains a Lore repository')).toBeVisible();

  await window.getByRole('button', { name: 'Add Existing Workspace' }).click();
  await expect(window.getByText('Define Workspace')).not.toBeVisible();
}

test.describe('Mission Control (offline repository, no live server)', () => {
  test('the pill shows no attention chip when there are no workspaces', async () => {
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    await window.getByPlaceholder('lores://lore.example.com').fill('lore.example.com');
    await window.getByRole('button', { name: 'Connect' }).click();

    // The pill renders (see morph.spec.ts); with no workspaces at all, its
    // attention chip (design 1b — amber pulse or quiet play chip) is absent.
    await expect(window.locator('.morph-pill-bar')).toBeVisible();
    await expect(window.getByText(/need.*you|working, none need you/i)).toHaveCount(0);

    await electronApp.close();
    removeTempUserDataDir(userDataDir);
  });

  test('opens from the card footer icon showing the anchor as the sole idle member, and the provision modal validates input on the cancel path', async () => {
    const repoDir = createOfflineLoreRepo();
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    await connectAndExpand(window);
    await addExistingRepository(electronApp, window, repoDir);

    // Adding a repository auto-selects it, enabling the footer's Mission
    // Control entry point (design 1c's sixth footer icon).
    const missionControlIcon = window.getByLabel('Mission Control');
    await expect(missionControlIcon).toBeEnabled();

    const [mcWindow] = await Promise.all([
      electronApp.waitForEvent('window'),
      missionControlIcon.click(),
    ]);

    await expect(mcWindow.getByText('Mission Control')).toBeVisible();
    // No workspace was ever provisioned against this repo (provisioning needs
    // a live server, P1 finding b) — but since the U3 unification, Mission
    // Control composes the anchor (the card-view checkout itself) as a listed
    // member alongside any provisioned worktrees. With zero provisioned
    // worktrees, the anchor is the sole member: one idle row, marked active,
    // not the old "no workspaces" empty state (that copy is now only reached
    // when the anchor itself fails to resolve, e.g. a deleted repository).
    await expect(mcWindow.getByText('1 workspace · this repo only')).toBeVisible();
    await expect(mcWindow.getByText('Idle · 1')).toBeVisible();
    const idleRow = mcWindow.getByTestId('idle-workspace-row');
    await expect(idleRow).toBeVisible();
    await expect(idleRow.getByText('active', { exact: true })).toBeVisible();
    // The anchor's ✕ and Forget are disabled in place (design amendment) —
    // it is the workspace currently open in the card, so neither teardown nor
    // forget applies to it from Mission Control.
    await expect(idleRow.getByLabel(/^Forget workspace /)).toBeDisabled();
    await expect(idleRow.getByLabel(/^Close workspace /)).toBeDisabled();

    // Provision modal: validates the branch name field and offers a cancel
    // path — no real clone is attempted (P1 finding b: shared-store clone
    // needs a live server; offline is blocked).
    await mcWindow.getByRole('button', { name: 'Provision workspace' }).click();
    const provisionDialog = mcWindow.getByRole('dialog', { name: 'Provision workspace' });
    await expect(provisionDialog).toBeVisible();

    const provisionButton = mcWindow.getByRole('button', { name: 'Provision', exact: true });
    const branchInput = mcWindow.getByLabel('New branch name');

    // Empty name: rejected without ever calling onSubmit.
    await provisionButton.click();
    await expect(mcWindow.getByText('Branch name is required')).toBeVisible();

    // A ".." path segment: also rejected.
    await branchInput.fill('agent/../escape');
    await provisionButton.click();
    await expect(mcWindow.getByText('Branch name cannot contain a “..” segment')).toBeVisible();

    // A valid name previews the worktree directory it would create.
    await branchInput.fill('agent/my-task');
    await expect(mcWindow.locator('pre')).toContainText('agent/my-task');

    // Cancel path: closes without provisioning.
    await mcWindow.getByRole('button', { name: 'Cancel' }).click();
    await expect(provisionDialog).not.toBeVisible();
    // Still just the anchor — cancelling never called the provision IPC.
    await expect(mcWindow.getByText('1 workspace · this repo only')).toBeVisible();

    await mcWindow.close();
    await electronApp.close();
    removeTempUserDataDir(userDataDir);
    removeOfflineLoreRepo(repoDir);
  });

  // Teardown confirm modal (design 2a's ✕ → confirm flow): reaching a
  // MissionCard in the "awaiting review"/"in progress" bands requires a real
  // provisioned workspace, which requires a shared-store clone against a live
  // server (P1 finding b) — unreachable in this environment. The IPC seam
  // (`window.electronAPI`) is exposed via `contextBridge.exposeInMainWorld`,
  // whose API surface Electron freezes in the isolated world: it cannot be
  // monkey-patched from the renderer to fabricate a card, and there is no
  // main-service stubbing utility in this harness (launch.ts only launches
  // the real built app). The gating logic itself (confirm/cancel, the
  // "force" checkbox for dirty/unpushed workspaces) is covered by
  // tests/renderer/mission-control/TeardownConfirmModal.test.tsx and
  // MissionControlView.test.tsx against mocked props — this e2e suite
  // documents rather than duplicates that coverage.
});
