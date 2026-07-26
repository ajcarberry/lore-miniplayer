import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  useLiveServer,
  connect,
  addAndClone,
  writeInClone,
  loreInClone,
  openProjectView,
  chooseWorkflow,
  exitProjectView,
  acceptMine,
  acceptTheirs,
  completeMerge,
  abortMerge,
  mergeGateEnabled,
  landedBannerText,
} from './support/ui';
import { seedRepo, secondClient, type LoreTestServer } from './live-server.setup';
import type { SecondClient } from '../../integration/support/world';

// The review window's MERGE workflow against a real Electron app, a real
// `loreserver`, and real working copies, opened from the card's WorkingSet
// header Merge action with the checkout switched onto a feature branch. Every
// landing is verified from a SECOND, independent client syncing the target
// branch — the only honest proof the merge reached the server. Requires
// `pnpm build` first.
test.describe.configure({ timeout: 300_000, retries: 1 });

const MESH = 'meshes/cave-entrance.mesh';
const BASE_MESH = 'mesh-format-v1\nvertices: 128\nfaces: 64\n';
// Both sides edit the SAME line, so the merge really conflicts.
const BRANCH_MESH = 'mesh-format-v1\nvertices: 256\nfaces: 64\n';
const MAIN_MESH = 'mesh-format-v1\nvertices: 512\nfaces: 64\n';

// One side column of a conflict block: ConflictBlock renders the side's
// SectionLabel and its content box as the two children of the column Box, so
// the label's parent IS the column.
function conflictSide(page: Page, path: string, label: string): Locator {
  return page
    .getByTestId(`conflict-block-${path}`)
    .getByText(label, { exact: true })
    .locator('xpath=..');
}

interface MergeScenario {
  readonly clonePath: string;
  readonly user2: SecondClient;
}

// The shared arrangement for every scenario below: the app connected and
// cloned; the checkout moved (out-of-band, via the real CLI) onto a feature
// branch carrying one committed, deliberately UNPUSHED edit of the mesh — a
// branch lands on main through the merge workflow, not through a push of its
// own; and a second client that pushed an OVERLAPPING edit of the same line
// to main first. Each scenario supplies a unique repo name so no two share
// server state.
async function arrange(
  window: Page,
  electronApp: ElectronApplication,
  server: LoreTestServer,
  homeDir: string,
  repoName: string,
  branchName: string
): Promise<MergeScenario> {
  const repo = await seedRepo(server, repoName, { [MESH]: BASE_MESH });

  await connect(window, server.grpcUrl);
  const { clonePath } = await addAndClone(window, electronApp, repoName);

  // Branch + commit in the app's checkout through the CLI; the card's
  // local-state watcher notices the out-of-band switch and re-derives the
  // current branch, which is what surfaces the Merge action.
  await loreInClone(homeDir, clonePath, ['branch', 'create', branchName]);
  await loreInClone(homeDir, clonePath, ['branch', 'switch', branchName]);
  await writeInClone(clonePath, { [MESH]: BRANCH_MESH });
  await loreInClone(
    homeDir,
    clonePath,
    ['stage', '.', '--scan'],
    ['commit', 'Widen the cave entrance to 256 vertices']
  );

  // A second, independent client pushes an OVERLAPPING edit of the same line
  // to main first.
  const user2 = await secondClient(server, repo.url, 'main-author');
  await user2.commitAndPush({ [MESH]: MAIN_MESH }, 'another author raises the budget to 512');

  // The Merge entry appears once the card has re-derived the branch AND the
  // land predicate reads true — the gate itself is part of the arrangement.
  await expect(window.getByRole('button', { name: 'Merge', exact: true })).toBeVisible({
    timeout: 60_000,
  });

  return { clonePath, user2 };
}

test.describe('Live merge — the branch lands on main', () => {
  useLiveServer();

  test('a conflicted merge shows both real sides, gates Merge, and lands MINE on main', async ({
    window,
    electronApp,
    server,
    homeDir,
  }) => {
    const branchName = 'feat/widen-entrance';
    const { clonePath, user2 } = await arrange(
      window,
      electronApp,
      server,
      homeDir,
      'merge-mine',
      branchName
    );

    // When: the merge is opened from the card's WorkingSet header
    const review = await openProjectView(window, 'Merge');

    // Then: the merge header names both branches, and the conflicted file is
    // listed with BOTH REAL sides — theirs is main's content, mine is the
    // branch's, both read back through the diff bridge, not invented.
    await expect(review.getByText(`Merge — ${branchName} → main`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(review.getByTestId(`conflict-block-${MESH}`)).toBeVisible({ timeout: 30_000 });
    await expect(review.getByText(/· 1 conflict$/)).toBeVisible();
    await expect(conflictSide(review, MESH, 'Theirs — main')).toContainText('vertices: 512');
    await expect(conflictSide(review, MESH, `Mine — ${branchName}`)).toContainText('vertices: 256');

    // And: the SDK really did materialize the diff3 markers on disk
    expect(await readFile(join(clonePath, MESH), 'utf8')).toMatch(
      /<<<<<<< ours[\s\S]*\|\|\|\|\|\|\| original[\s\S]*>>>>>>> theirs/
    );

    // And: Merge is gated until the conflict is resolved
    await expect(review.getByText('0 of 1 conflicts resolved')).toBeVisible();
    expect(await mergeGateEnabled(review)).toBe(false);

    // When: the branch's side is accepted
    await acceptMine(review, MESH);

    // Then: the gate lifts
    await expect(review.getByTestId(`conflict-block-${MESH}`).getByText('Accepted')).toBeVisible({
      timeout: 30_000,
    });
    await expect(review.getByText('1 of 1 conflicts resolved')).toBeVisible();
    expect(await mergeGateEnabled(review)).toBe(true);

    // When: the merge is completed
    await completeMerge(review);

    // Then: the landed line names the revision that reached main
    await expect(review.getByText(/^Landed .* on main$/)).toBeVisible({ timeout: 90_000 });
    const banner = await landedBannerText(review);
    expect(banner).toMatch(/^Landed \S+ on main$/);
    await expect(review.getByText(/^Merged — landed .* on main\./)).toBeVisible();

    // And: a second, independent client syncing main really sees the branch's
    // content there — the only honest proof the landing reached the server.
    await expect
      .poll(
        async () => {
          try {
            return await user2.syncAndRead(MESH);
          } catch {
            return '';
          }
        },
        { timeout: 90_000 }
      )
      .toBe(BRANCH_MESH);

    // And: the header switcher crosses to the commit view directly — the
    // merge landed, so nothing needs discarding — where the Merge segment
    // reads disabled once the land predicate refreshes (nothing left to land).
    await chooseWorkflow(window, 'Review');
    await expect(window.getByLabel('Commit message')).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole('radio', { name: 'Merge' })).toBeDisabled({ timeout: 60_000 });

    await exitProjectView(window);

    // And: the card withdraws its Merge entry — the branch has nothing left
    // that main lacks, so a merge that would land nothing is never offered.
    await expect(window.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0, {
      timeout: 60_000,
    });
  });

  test('a conflicted merge resolved as THEIRS lands main’s content on main', async ({
    window,
    electronApp,
    server,
    homeDir,
  }) => {
    const branchName = 'feat/keep-main';
    const { user2 } = await arrange(
      window,
      electronApp,
      server,
      homeDir,
      'merge-theirs',
      branchName
    );

    const review = await openProjectView(window, 'Merge');
    await expect(review.getByTestId(`conflict-block-${MESH}`)).toBeVisible({ timeout: 60_000 });

    // When: main's side is accepted instead
    await acceptTheirs(review, MESH);
    await expect(review.getByText('1 of 1 conflicts resolved')).toBeVisible({ timeout: 30_000 });
    expect(await mergeGateEnabled(review)).toBe(true);
    await completeMerge(review);
    await expect(review.getByText(/^Landed .* on main$/)).toBeVisible({ timeout: 90_000 });

    // Then: main keeps its own content — the branch's edit did NOT win
    await expect
      .poll(
        async () => {
          try {
            return await user2.syncAndRead(MESH);
          } catch {
            return '';
          }
        },
        { timeout: 90_000 }
      )
      .toBe(MAIN_MESH);

    await exitProjectView(window);
  });

  test('aborting a conflicted merge restores the working tree and frees a fresh merge', async ({
    window,
    electronApp,
    server,
    homeDir,
  }) => {
    const branchName = 'feat/abort-me';
    const { clonePath } = await arrange(
      window,
      electronApp,
      server,
      homeDir,
      'merge-abort',
      branchName
    );

    const review = await openProjectView(window, 'Merge');
    await expect(review.getByTestId(`conflict-block-${MESH}`)).toBeVisible({ timeout: 60_000 });

    // When: the abort is asked for and then cancelled, the merge stays
    await abortMerge(review, { confirm: false });
    await expect(review.getByTestId(`conflict-block-${MESH}`)).toBeVisible();

    // When: the abort is confirmed
    await abortMerge(review);

    // Then: the surface morphs back to the card by itself…
    await expect(window.getByText('Working Set')).toBeVisible({ timeout: 30_000 });

    // …and the checkout's working file is the branch's own pre-merge content:
    // no diff3 markers, no main-side content.
    expect(await readFile(join(clonePath, MESH), 'utf8')).toBe(BRANCH_MESH);

    // And: the merge can simply be started again — an aborted merge leaves no
    // orphaned on-disk state to dead-end on. Backing out mid-merge routes
    // through the same discard confirmation.
    const second = await openProjectView(window, 'Merge');
    await expect(second.getByTestId(`conflict-block-${MESH}`)).toBeVisible({ timeout: 60_000 });
    await expect(second.getByText('0 of 1 conflicts resolved')).toBeVisible();

    // Leaving a live merge through the workflow switcher routes through the
    // same discard confirmation, then lands in the commit view — not the card.
    await chooseWorkflow(second, 'Review');
    const dialog = second.getByRole('dialog', { name: 'Discard this merge?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Discard merge', exact: true }).click();
    await expect(second.getByLabel('Commit message')).toBeVisible({ timeout: 30_000 });
    await exitProjectView(window);
  });
});
