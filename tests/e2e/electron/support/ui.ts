import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from '../launch';
import {
  startLoreServer,
  isolatedFfiHomeEnv,
  stubDirectoryPicker,
  createCloneBaseDir,
  type LoreTestServer,
} from '../live-server.setup';

// Page-object helper layer over the live Electron app. The scenario packets
// (WP-U3…U6) drive every capability through these helpers so a selector only
// ever lives in one place. Selectors are grounded in the affordance survey and
// verified against the real renderer components.
//
// Launch model (from WP-U1, unchanged): workers:1 / fullyParallel:false sustains
// many sequential real launches in one worker. Per test the `electronApp`
// fixture does launchApp(undefined, isolatedFfiHomeEnv()) → firstWindow() →
// guaranteed app.close() + removeTempUserDataDir.

export { expect };

// The live `loreserver` for the current spec file. Set by `useLiveServer()` in a
// beforeAll and read by the `server` fixture, so tests can destructure it.
let currentServer: LoreTestServer | undefined;

interface LiveFixtures {
  electronApp: ElectronApplication;
  window: Page;
  server: LoreTestServer;
}

export const test = base.extend<LiveFixtures>({
  electronApp: async ({}, use) => {
    const { app, userDataDir } = await launchApp(undefined, await isolatedFfiHomeEnv());
    await use(app);
    await app.close();
    removeTempUserDataDir(userDataDir);
  },
  window: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow());
  },
  server: async ({}, use) => {
    if (currentServer === undefined) {
      throw new Error('server fixture used without useLiveServer() in a beforeAll');
    }
    await use(currentServer);
  },
});

// Registers the per-file live-server lifecycle: skip the whole block on Windows
// (the harness provisions loreserver only on macOS/Linux), start one server in a
// beforeAll, stop it in an afterAll. Call it at the top of a describe; the
// `server` fixture then resolves to that server.
export function useLiveServer(): void {
  test.skip(
    process.platform === 'win32',
    'lore harness provisions loreserver only on macOS/Linux (binaries.ts mapOs has no win32 case)'
  );
  test.beforeAll(async () => {
    currentServer = await startLoreServer();
  });
  test.afterAll(async () => {
    await currentServer?.stop();
    currentServer = undefined;
  });
}

// --- Connect + expansion ---------------------------------------------------

// Fill the address, Connect, expand the pill to the card, and await the
// connected header. The explicit scheme (lore://) is kept as entered.
export async function connect(window: Page, grpcUrl: string): Promise<void> {
  await window.getByPlaceholder('lores://lore.example.com').fill(grpcUrl);
  await window.getByRole('button', { name: 'Connect' }).click();
  await window.locator('.morph-pill').click();
  await expect(window.getByText('On branch')).toBeVisible({ timeout: 20_000 });
}

// Collapse the expanded card back to the ambient pill. Uses the title bar's
// control rather than re-clicking .morph-pill, which the card covers while open.
export async function collapseToPill(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Collapse to pill' }).click();
  await expect(window.locator('.morph-root')).toHaveAttribute('data-expanded', 'false');
}

// Expand the collapsed pill back to the full card.
export async function expandToCard(window: Page): Promise<void> {
  await window.locator('.morph-pill').click();
  await expect(window.locator('.morph-root')).toHaveAttribute('data-expanded', 'true');
}

// --- Add repository --------------------------------------------------------

// Open the Add Repository modal from the footer repositories popover.
export async function openAddRepository(window: Page): Promise<void> {
  await window.getByLabel('Repositories').click();
  await window.getByText('Add repository…').click();
  await expect(window.getByText('Define Repository')).toBeVisible();
}

interface AddAndCloneOptions {
  // Hook fired after the form is ready but before the clone submits — lets UJ
  // instrument the clone-progress channel.
  readonly onBeforeSubmit?: () => Promise<void>;
}

// Search the remote list, select `repoName`, stub + pick a fresh base
// directory, submit "Add & Clone Repository", and await the real clone finish.
export async function addAndClone(
  window: Page,
  app: ElectronApplication,
  repoName: string,
  options: AddAndCloneOptions = {}
): Promise<void> {
  await openAddRepository(window);

  const search = window.getByPlaceholder('Search repositories...');
  await search.click();
  await search.fill(repoName);
  await window.getByRole('option', { name: repoName, exact: true }).click();

  const baseDir = await createCloneBaseDir();
  await stubDirectoryPicker(app, baseDir);
  await window.getByLabel('Select base directory').click();

  const submit = window.getByRole('button', { name: 'Add & Clone Repository' });
  await expect(submit).toBeEnabled();

  if (options.onBeforeSubmit) {
    await options.onBeforeSubmit();
  }

  await submit.click();
  await expect(window.getByText('Define Repository')).not.toBeVisible({ timeout: 30_000 });
}

// Open the modal and add a directory that is already a Lore repo on disk: the
// stubbed picker resolves to `existingRepoDir`, the modal flips to the
// "existing" mode, and the existing-repo submit finishes the add.
export async function addExisting(
  window: Page,
  app: ElectronApplication,
  existingRepoDir: string
): Promise<void> {
  await openAddRepository(window);

  await stubDirectoryPicker(app, existingRepoDir);
  await window.getByLabel('Select base directory').click();

  const submit = window.getByRole('button', { name: 'Add Existing Repository' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(window.getByText('Define Repository')).not.toBeVisible({ timeout: 30_000 });
}

// --- Repository picker -----------------------------------------------------

// Open the footer repositories popover.
export async function openRepositoryPicker(window: Page): Promise<void> {
  await window.getByLabel('Repositories').click();
}

// Open the picker and click the `repoName` row.
export async function selectRepository(window: Page, repoName: string): Promise<void> {
  await openRepositoryPicker(window);
  await window.getByRole('button', { name: repoName, exact: true }).click();
}

// The repository name in the card header eyebrow. The name also renders in the
// always-mounted pill, so this scopes to the header's Switch-branch button.
export function repoHeaderName(window: Page, repoName: string): Locator {
  return window.getByRole('button', { name: 'Switch branch' }).getByText(repoName, { exact: true });
}

// --- Branch switcher -------------------------------------------------------

// Open the branch switcher from the card header.
export async function openBranchSwitcher(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Switch branch' }).click();
}

// Open the switcher, filter, and pick `branchName` from the list.
export async function switchBranch(window: Page, branchName: string): Promise<void> {
  await openBranchSwitcher(window);
  await window.getByPlaceholder('Search branches...').fill(branchName);
  await window.getByRole('button', { name: branchName, exact: true }).click();
}

// The current branch name, read from the header's branch line (the second
// Text, the mono branch label, beneath the repo-name eyebrow).
export async function currentBranch(window: Page): Promise<string> {
  const text = await window
    .getByRole('button', { name: 'Switch branch' })
    .locator('p')
    .last()
    .textContent();
  return (text ?? '').trim();
}

// --- Working set -----------------------------------------------------------

// Expand the Working Set section.
export async function openWorkingSet(window: Page): Promise<void> {
  await window.getByText('Working Set').click();
}

// The per-file checkbox (aria-label = the relative path; checked = staged).
export function workingSetRow(window: Page, relPath: string): Locator {
  return window.getByLabel(relPath);
}

// The change-kind badge for a working-set file: 'A' (add) or 'M' (edit).
export async function fileKindBadge(window: Page, relPath: string): Promise<'A' | 'M'> {
  const badge = window
    .getByLabel(relPath)
    .locator(
      'xpath=ancestor::div[.//p[normalize-space()="A" or normalize-space()="M"]][1]' +
        '//p[normalize-space()="A" or normalize-space()="M"]'
    )
    .first();
  const text = (await badge.textContent())?.trim();
  return text === 'A' ? 'A' : 'M';
}

// Toggle a working-set file's staged state via its checkbox.
export async function toggleStage(window: Page, relPath: string): Promise<void> {
  await window.getByLabel(relPath).click();
}

// --- Commit / push / sync --------------------------------------------------

// Open the commit dialog, write `message`, and commit.
export async function commit(window: Page, message: string): Promise<void> {
  await window.getByText('Commit', { exact: true }).click();
  const textarea = window.locator('textarea[data-autofocus]');
  await textarea.fill(message);
  await window.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(textarea).toHaveCount(0, { timeout: 30_000 });
}

// Push via the Push transport cell.
export async function push(window: Page): Promise<void> {
  await window.getByText('Push', { exact: true }).click();
}

// Sync to the branch tip via the Sync transport cell.
export async function syncToLatest(window: Page): Promise<void> {
  await window.getByText('Sync', { exact: true }).click();
}

interface SyncToRevisionOptions {
  readonly keepLocal?: boolean;
}

// Open the split sync menu, choose "Sync to Revision…", fill the revision, and
// sync (optionally keeping local changes).
export async function syncToRevision(
  window: Page,
  revisionText: string,
  options: SyncToRevisionOptions = {}
): Promise<void> {
  await window.getByLabel('More sync options').click();
  await window.getByRole('menuitem', { name: 'Sync to Revision…' }).click();
  await expect(window.getByText('Sync to Specific Revision')).toBeVisible();
  await window.getByPlaceholder('abc123def456 or @2').fill(revisionText);
  if (options.keepLocal) {
    await window.getByRole('checkbox', { name: 'Keep local changes' }).check();
  }
  await window.getByRole('button', { name: 'Sync to Revision' }).click();
}

// Open the split sync menu, choose Reset, and confirm the workspace reset.
export async function resetWorkspace(window: Page): Promise<void> {
  await window.getByLabel('More sync options').click();
  await window.getByRole('menuitem', { name: 'Reset' }).click();
  await expect(window.getByText('Confirm Reset')).toBeVisible();
  await window.getByRole('button', { name: 'Reset Repository' }).click();
}

// --- History ---------------------------------------------------------------

// Await the History section header (the section is always mounted in normal mode).
export async function openHistory(window: Page): Promise<void> {
  await expect(window.getByText('History', { exact: true })).toBeVisible();
}

// Click the timeline node for revision number `n`.
export async function selectRevision(window: Page, n: number): Promise<void> {
  await window.getByRole('button', { name: `Select revision r${n}` }).click();
}

// The "No history yet" empty-state locator.
export function historyEmpty(window: Page): Locator {
  return window.getByText('No history yet');
}

// --- Pill signals ----------------------------------------------------------

interface PillSignals {
  readonly syncNotice: boolean;
  readonly uncommitted: boolean;
  readonly unpushed: boolean;
}

// The collapsed pill's action signals: the sync-notice pulse (from the pill
// bar's data-notice) plus the uncommitted/unpushed glyphs (aria-labels).
export async function readPillSignals(window: Page): Promise<PillSignals> {
  const syncNotice =
    (await window.locator('.morph-pill-bar').getAttribute('data-notice')) === 'sync';
  const uncommitted = (await window.getByLabel('Uncommitted changes').count()) > 0;
  const unpushed = (await window.getByLabel('Commits to push').count()) > 0;
  return { syncNotice, uncommitted, unpushed };
}

// --- Transport captions ----------------------------------------------------

// The sub-caption text of a transport cell (its second/last Text line).
async function cellCaption(window: Page, label: string): Promise<string> {
  const text = await window
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::button[1]')
    .locator('p')
    .last()
    .textContent();
  return (text ?? '').trim();
}

// The Sync cell sub-caption ("Current" / "Older revision" / "Behind remote" /
// "Switch & sync").
export async function syncCaption(window: Page): Promise<string> {
  return cellCaption(window, 'Sync');
}

// The Push cell sub-caption ("Up to date" / "To push" / "—").
export async function pushCaption(window: Page): Promise<string> {
  return cellCaption(window, 'Push');
}

// Whether a transport cell is the accented primary action (its data-primary).
export async function transportAccented(
  window: Page,
  label: 'Sync' | 'Commit' | 'Push'
): Promise<boolean> {
  const primary = await window
    .getByText(label, { exact: true })
    .locator('xpath=ancestor::button[1]')
    .getAttribute('data-primary');
  return primary === 'true';
}
