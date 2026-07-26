import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { launchApp, closeAppBounded, removeTempUserDataDir } from '../launch';
import {
  startLoreServer,
  isolatedFfiHomeEnv,
  stubDirectoryPicker,
  createCloneBaseDir,
  type LoreTestServer,
} from '../live-server.setup';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSeedFiles, type SeedFiles } from '../../../integration/support/world';
import { isolatedHomeEnv } from '../../../integration/harness/server';
import { ensureLoreBinaries } from '../../../integration/harness/binaries';

const execFileAsync = promisify(execFile);

// Run the real `lore` CLI against the app's own clone, under the app's
// isolated HOME (the clone's store lives there) — the out-of-band way an
// agent or terminal user moves a checkout onto its own branch.
export async function loreInClone(
  homeDir: string,
  clonePath: string,
  ...invocations: string[][]
): Promise<void> {
  const { lore } = await ensureLoreBinaries();
  const env = { ...process.env, ...isolatedHomeEnv(homeDir) };
  for (const args of invocations) {
    await execFileAsync(lore, [...args, '--repository', clonePath], { env });
  }
}

// Page-object helper layer over the live Electron app, so each selector lives in
// one place. Launch model: workers:1 / fullyParallel:false sustains many
// sequential real launches per worker; each test's electronApp fixture runs
// launchApp → firstWindow → close + removeTempUserDataDir.

export { expect };

// The live `loreserver` for the current spec file. Set by `useLiveServer()` in a
// beforeAll and read by the `server` fixture, so tests can destructure it.
let currentServer: LoreTestServer | undefined;

interface LiveFixtures {
  electronApp: ElectronApplication;
  window: Page;
  server: LoreTestServer;
  // The isolated $HOME the launched app's FFI reads/writes (see
  // isolatedFfiHomeEnv), exposed so tests can drive the `lore` CLI against
  // the app's own clone (its store lives under this HOME).
  homeDir: string;
}

export const test = base.extend<LiveFixtures>({
  // Same isolated HOME the electronApp fixture launches with — derived once
  // here and reconstructed into env vars for the launch, so both fixtures
  // agree on the same directory.
  homeDir: async ({}, use) => {
    const env = await isolatedFfiHomeEnv();
    const home = env['HOME'];
    if (home === undefined) {
      throw new Error('isolatedFfiHomeEnv() did not set HOME');
    }
    await use(home);
    await rm(home, { recursive: true, force: true });
  },
  electronApp: async ({ homeDir }, use) => {
    const { app, userDataDir } = await launchApp(undefined, isolatedHomeEnv(homeDir));
    await use(app);
    await closeAppBounded(app);
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
// Returns the on-disk working-copy path the app cloned into — `<baseDir>/
// <friendlyName>` — so scenarios can mutate the working copy. The subfolder
// name is read back from the (freshly created, so single-entry) base dir
// rather than assumed, keeping the helper independent of the app's naming.
export async function addAndClone(
  window: Page,
  app: ElectronApplication,
  repoName: string,
  options: AddAndCloneOptions = {}
): Promise<{ clonePath: string }> {
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

  const entries = await readdir(baseDir, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory());
  const [cloneDir] = dirs;
  if (dirs.length !== 1 || cloneDir === undefined) {
    throw new Error(
      `expected exactly one clone subfolder under ${baseDir}, found: ${dirs
        .map(dir => dir.name)
        .join(', ')}`
    );
  }
  return { clonePath: join(baseDir, cloneDir.name) };
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

// Remove a repository from the app's list (not from the server): open the
// picker, click the row's "Edit <name>" pencil to open the fullscreen
// EditRepositoryModal, hit "Delete Repository" to reveal the DeleteConfirmation
// panel, then confirm with "Remove from Lore". The modal closes on confirm.
export async function deleteRepository(window: Page, repoName: string): Promise<void> {
  await openRepositoryPicker(window);
  await window.getByLabel(`Edit ${repoName}`).click();
  await expect(window.getByText('Edit Repository')).toBeVisible();
  await window.getByRole('button', { name: 'Delete Repository' }).click();
  await window.getByRole('button', { name: 'Remove from Lore' }).click();
  await expect(window.getByText('Edit Repository')).not.toBeVisible();
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

// Write/overwrite a map of repo-relative files directly in the on-disk working
// copy (from addAndClone's clonePath), reusing the harness's seed writer. Use
// to stage an edit (existing path) or an add (new path) before a refresh.
export async function writeInClone(clonePath: string, files: SeedFiles): Promise<void> {
  await writeSeedFiles(clonePath, files);
}

// Force the card to re-read working-copy status after an on-disk change. There
// is no manual reload: status re-reads on a 3s poll or when the selected repo's
// identity changes. Refresh replaces the repo list with fresh identities, then
// re-selecting the active repo re-runs the load effect at once — no blind wait.
export async function refreshWorkingSet(window: Page): Promise<void> {
  await window.getByLabel('Repositories').click();
  await window.getByText('Refresh', { exact: true }).click();
  await window.locator('[data-active="true"]').getByRole('button').first().click();
}

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
  if (text === 'A' || text === 'M') {
    return text;
  }
  throw new Error(`unexpected change-kind badge for ${relPath}: ${JSON.stringify(text)}`);
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

// --- External-launcher shortcuts -------------------------------------------

interface OpenExternalsStub {
  // Paths passed to repository:open-in-explorer (the footer "Open in File
  // Explorer" shortcut, which really calls shell.openPath).
  readonly explorerCalls: () => Promise<string[]>;
  // Paths passed to window:open-terminal (the footer "Open Terminal here"
  // shortcut, which really spawns an OS terminal).
  readonly terminalCalls: () => Promise<string[]>;
}

// Replace the two external-launching ipcMain handlers with capturing stubs so
// the footer shortcuts can be asserted (invocation + path) without launching
// Finder/Terminal. Returns a void-success Result so the renderer's success path
// runs unchanged. Call before clicking the shortcuts.
export async function stubOpenExternals(app: ElectronApplication): Promise<OpenExternalsStub> {
  await app.evaluate(({ ipcMain }) => {
    const globals = globalThis as typeof globalThis & {
      __openExternals?: { explorer: string[]; terminal: string[] };
    };
    const store = globals.__openExternals ?? { explorer: [], terminal: [] };
    globals.__openExternals = store;

    ipcMain.removeHandler('repository:open-in-explorer');
    ipcMain.handle('repository:open-in-explorer', (_event, path: string) => {
      store.explorer.push(path);
      return { success: true, data: undefined };
    });

    ipcMain.removeHandler('window:open-terminal');
    ipcMain.handle('window:open-terminal', (_event, path: string) => {
      store.terminal.push(path);
      return { success: true, data: undefined };
    });
  });

  const read = (key: 'explorer' | 'terminal'): Promise<string[]> =>
    app.evaluate((_electron, k) => {
      const globals = globalThis as typeof globalThis & {
        __openExternals?: { explorer: string[]; terminal: string[] };
      };
      return globals.__openExternals?.[k] ?? [];
    }, key);

  return {
    explorerCalls: () => read('explorer'),
    terminalCalls: () => read('terminal'),
  };
}

// --- Review window -----------------------------------------------------

export type ReviewCardAction = 'Review' | 'Merge';

// Click the card's WorkingSet-header Review/Merge action; the card morphs
// into the Project View in the SAME window (returned for assertion
// continuity). Awaits the view's Back control so callers see it mounted.
export async function openProjectView(window: Page, action: ReviewCardAction): Promise<Page> {
  // Scoped to the card: for ~400ms after a previous exit the dying view is
  // still in the accessibility tree with its own 'Merge' bar button.
  await window.locator('.morph-card').getByRole('button', { name: action, exact: true }).click();
  await expect(window.getByLabel('Back')).toBeVisible({ timeout: 30_000 });
  return window;
}

// The footer's always-visible opener (left of Open in File Explorer).
export async function openProjectViewFromFooter(window: Page): Promise<Page> {
  await window.getByRole('button', { name: 'Open Project View' }).click();
  await expect(window.getByLabel('Back')).toBeVisible({ timeout: 30_000 });
  return window;
}

// Leave the Project View through its header Back control and await the card
// taking back over.
export async function exitProjectView(window: Page): Promise<void> {
  await window.getByLabel('Back').click();
  await expect(window.getByText('Working Set')).toBeVisible({ timeout: 30_000 });
}

// Collapse from the Project View straight to the ambient pill via its
// TitleBar control (scoped to the view — the hidden card carries the same
// control until its visibility flips).
export async function collapseFromProjectView(window: Page): Promise<void> {
  await window.locator('.morph-project-view').getByLabel('Collapse to pill').click();
  await expect(window.locator('.morph-pill-bar')).toBeVisible({ timeout: 30_000 });
}

// Change the compare picker's source or target endpoint to the menu item
// matching `label` (a revision string, "<revision> · <message>", or — target
// only — "working tree"; see ComparePicker.tsx).
export async function selectCompareEndpoint(
  page: Page,
  endpoint: 'source' | 'target',
  label: string
): Promise<void> {
  const ariaLabel = endpoint === 'source' ? 'Change compare source' : 'Change compare target';
  await page.getByLabel(ariaLabel).click();
  // .last(): a just-closed sibling menu's DOM can linger through its close
  // transition, briefly duplicating revision items; portals mount in open
  // order, so the newest menu is last.
  await page.getByRole('menuitem', { name: label }).last().click();
}

// Stage/unstage a review file-list row via its checkbox (FileList.tsx;
// unresolved conflicts render a warning icon instead and cannot be staged).
// Deliberately click + await rather than Locator.check()/uncheck(): the box is
// a CONTROLLED input whose checked state only flips after the stage IPC round
// trip resolves, and check() verifies the state immediately after its click
// with no retry ("Clicking the checkbox did not change its state"). Mirrors
// the working-set helper's click-then-assert shape.
export async function stageFileRow(page: Page, relPath: string): Promise<void> {
  const checkbox = page.getByLabel(`Stage ${relPath}`);
  await checkbox.click();
  await expect(checkbox).toBeChecked({ timeout: 30_000 });
}

export async function unstageFileRow(page: Page, relPath: string): Promise<void> {
  const checkbox = page.getByLabel(`Stage ${relPath}`);
  await checkbox.click();
  await expect(checkbox).not.toBeChecked({ timeout: 30_000 });
}

// The file-list row's single-letter change-kind badge (M/A/D/R — FileList.tsx's
// ACTION_BADGE), read the same structural way as the working-set fileKindBadge
// above.
export async function fileRowBadge(page: Page, relPath: string): Promise<'A' | 'M' | 'D' | 'R'> {
  const isBadge =
    'normalize-space()="A" or normalize-space()="M" or normalize-space()="D" or normalize-space()="R"';
  const badge = page
    .getByLabel(`Stage ${relPath}`)
    .locator(`xpath=ancestor::div[.//p[${isBadge}]][1]//p[${isBadge}]`)
    .first();
  const text = (await badge.textContent())?.trim();
  if (text === 'A' || text === 'M' || text === 'D' || text === 'R') {
    return text;
  }
  throw new Error(`unexpected file-row badge for ${relPath}: ${JSON.stringify(text)}`);
}

// The Project View's own subtree. Bar-level role queries must scope here:
// during the card ↔ view crossfade (the first ~400ms) the card's controls are
// still in the accessibility tree, so an unscoped 'Merge'/'Commit' button
// query can hit both surfaces at once.
function projectView(page: Page): Locator {
  return page.locator('.morph-project-view');
}

// Fill the commit message and commit (CommitBar.tsx); awaits the bar's swap to
// its post-commit Push action.
export async function commitFromReview(page: Page, message: string): Promise<void> {
  await page.getByLabel('Commit message').fill(message);
  await projectView(page).getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(projectView(page).getByRole('button', { name: 'Push', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

export async function pushFromReview(page: Page): Promise<void> {
  await projectView(page).getByRole('button', { name: 'Push', exact: true }).click();
}

// Resolve one side of a conflicted file, scoped to its ConflictBlock
// (data-testid="conflict-block-<path>" — button text alone is not per-file).
export async function acceptMine(page: Page, filePath: string): Promise<void> {
  await page
    .getByTestId(`conflict-block-${filePath}`)
    .getByRole('button', { name: 'Accept mine', exact: true })
    .click();
}

export async function acceptTheirs(page: Page, filePath: string): Promise<void> {
  await page
    .getByTestId(`conflict-block-${filePath}`)
    .getByRole('button', { name: 'Accept theirs', exact: true })
    .click();
}

// The merge workflow's primary action (MergeBar.tsx) — gated on every
// conflict resolved and the branch actually being ahead of the target.
export async function completeMerge(page: Page): Promise<void> {
  await projectView(page).getByRole('button', { name: 'Merge', exact: true }).click();
}

interface AbortMergeOptions {
  // Default true: confirms the "Discard merge?" modal. false clicks "Keep
  // merging" instead, cancelling the abort.
  readonly confirm?: boolean;
}

export async function abortMerge(page: Page, options: AbortMergeOptions = {}): Promise<void> {
  await page.getByRole('button', { name: 'Abort', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard this merge?' });
  await expect(dialog).toBeVisible();
  if (options.confirm ?? true) {
    await dialog.getByRole('button', { name: 'Discard merge', exact: true }).click();
  } else {
    await dialog.getByRole('button', { name: 'Keep merging', exact: true }).click();
  }
}

// Whether the merge workflow's primary action is currently clickable.
export async function mergeGateEnabled(page: Page): Promise<boolean> {
  return projectView(page).getByRole('button', { name: 'Merge', exact: true }).isEnabled();
}

// The landed-merge line ("Landed <rev> on <target>" — MergeBar.tsx), or null
// before the merge completes.
export async function landedBannerText(page: Page): Promise<string | null> {
  const banner = page.getByText(/^Landed .* on /);
  if ((await banner.count()) === 0) {
    return null;
  }
  return ((await banner.first().textContent()) ?? '').trim();
}
