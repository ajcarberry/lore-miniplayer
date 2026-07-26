import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
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
  toggleStage,
  commit,
  syncToLatest,
  openProjectView,
  openProjectViewFromFooter,
  exitProjectView,
  collapseFromProjectView,
  selectCompareEndpoint,
  stageFileRow,
  unstageFileRow,
  fileRowBadge,
  commitFromReview,
  pushFromReview,
} from './support/ui';
import { seedRepo, secondClient } from './live-server.setup';

// The review window's COMMIT workflow against a real Electron app, a real
// `loreserver`, and a real working copy, opened from the card's WorkingSet
// header Review action. The conflict scenario reaches a REAL
// `flagConflictUnresolved` through a pending merge after sync (the path the
// divergence-and-conflict integration scenario proves carries the flags).
// Requires `pnpm build` first. The merge workflow itself belongs to
// live-merge.spec.ts.
test.describe.configure({ timeout: 240_000, retries: 1 });

const INITIAL_MESH = 'mesh-format-v1\nvertices: 128\nfaces: 64\n';
const EDITED_MESH = 'mesh-format-v1\nvertices: 256\nfaces: 64\n';
const STALE_MESH = 'stale-room\nvertices: 1\n';
const NEW_MESH = 'mesh-format-v1\nvertices: 12\n';
// Real binary bytes, changed in place — the SDK answers a `Binary files
// differ` sentinel patch for these (proven in the diff-compare integration
// suite), which is what drives the row's "binary" stats cell.
const INITIAL_TEXTURE = Buffer.from([0x54, 0x52, 0x55, 0x45, 0x00, 0x01, 0x02, 0x03]);
const EDITED_TEXTURE = Buffer.from([0x54, 0x52, 0x55, 0x45, 0xff, 0xff, 0x02, 0x03]);

// A file-list row's own <Group>: the nearest ancestor of the stage checkbox
// that also holds the row's change-kind badge (same structural anchor
// fileRowBadge uses, so it cannot drift from the FileList markup).
const BADGE_TEST =
  'normalize-space()="A" or normalize-space()="M" or normalize-space()="D" or normalize-space()="R"';

function fileRow(page: Page, relPath: string): Locator {
  return page
    .getByLabel(`Stage ${relPath}`)
    .locator(`xpath=ancestor::div[.//p[${BADGE_TEST}]][1]`)
    .first();
}

// Every path currently listed in the review window's file list, read from the
// stage checkboxes' aria-labels. Conflicted rows carry a warning instead of a
// checkbox, so they are deliberately absent here.
async function listedPaths(page: Page): Promise<string[]> {
  const labels = await page
    .getByLabel(/^Stage /)
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? ''));
  return labels.map(label => label.replace(/^Stage /, '')).sort();
}

test.describe('Live review — commit workflow', () => {
  useLiveServer();

  test('compare picker, file rows, staging, and commit → push seen by a second client', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: a repo with REAL history — two commits, the second adding a file
    // the working tree never touches, so a revision→revision compare has
    // something of its own to show.
    const repoName = 'review-commit';
    const repo = await seedRepo(server, repoName, {
      'meshes/cave-entrance.mesh': INITIAL_MESH,
      'meshes/old-room.mesh': STALE_MESH,
      'textures/rock-diffuse.tga': INITIAL_TEXTURE,
    });
    await writeInClone(repo.workdir, { 'meshes/pillar.mesh': 'mesh-format-v1\npillar: 1\n' });
    await server.lore(['stage', '.', '--scan', '--repository', repo.workdir]);
    await server.lore(['commit', 'Raise the pillar', '--repository', repo.workdir]);
    await server.lore(['push', '--repository', repo.workdir]);

    await connect(window, server.grpcUrl);
    const { clonePath } = await addAndClone(window, electronApp, repoName);

    // Then: with a clean working set there is nothing to review — no entry
    await expect(window.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);

    // And: one of each change kind in the checkout — an edit, an add, a
    // delete, and a real binary rewrite.
    await writeInClone(clonePath, {
      'meshes/cave-entrance.mesh': EDITED_MESH,
      'meshes/new-room.mesh': NEW_MESH,
      'textures/rock-diffuse.tga': EDITED_TEXTURE,
    });
    await rm(join(clonePath, 'meshes/old-room.mesh'));
    await refreshWorkingSet(window);

    // When: the review window is opened from the card's WorkingSet header
    // (the Review entry appears once the working set reads dirty)
    const review = await openProjectView(window, 'Review');

    // Then: the default compare (current revision → working tree) lists
    // exactly the dirty set, one row per change kind.
    await expect(review.getByLabel('Commit message')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => listedPaths(review), { timeout: 20_000 })
      .toEqual([
        'meshes/cave-entrance.mesh',
        'meshes/new-room.mesh',
        'meshes/old-room.mesh',
        'textures/rock-diffuse.tga',
      ]);
    expect(await fileRowBadge(review, 'meshes/cave-entrance.mesh')).toBe('M');
    expect(await fileRowBadge(review, 'meshes/new-room.mesh')).toBe('A');
    expect(await fileRowBadge(review, 'meshes/old-room.mesh')).toBe('D');
    expect(await fileRowBadge(review, 'textures/rock-diffuse.tga')).toBe('M');
    await expect(review.getByText(/^4 files · \+\d+ −\d+ · stage for commit$/)).toBeVisible();

    // And: the binary row reports "binary" instead of line stats, and its
    // diff pane says so rather than showing a patch.
    await expect(fileRow(review, 'textures/rock-diffuse.tga').getByText('binary')).toBeVisible();
    await expect(fileRow(review, 'textures/rock-diffuse.tga').getByText(/[+−]\d/)).toHaveCount(0);
    await review.getByText('textures/rock-diffuse.tga', { exact: true }).click();
    await expect(review.getByText(/Binary file/)).toBeVisible();

    // When: the compare source moves back to the first revision (still
    // against the working tree)
    await selectCompareEndpoint(review, 'source', 'Initial commit');

    // Then: the pane picks up the second commit's file on top of the dirty set
    await expect
      .poll(() => listedPaths(review), { timeout: 20_000 })
      .toContain('meshes/pillar.mesh');

    // When: the target moves off the working tree to the second revision —
    // a pure revision → revision compare
    await selectCompareEndpoint(review, 'target', 'Raise the pillar');

    // Then: only what that commit actually changed is listed; the
    // working-tree-only files are gone
    await expect
      .poll(() => listedPaths(review), { timeout: 20_000 })
      .toEqual(['meshes/pillar.mesh']);

    // When: the target returns to the working tree
    await selectCompareEndpoint(review, 'target', 'working tree');
    await expect
      .poll(() => listedPaths(review), { timeout: 20_000 })
      .toContain('meshes/new-room.mesh');

    // And: the edit is staged from its row
    await stageFileRow(review, 'meshes/cave-entrance.mesh');
    await expect(review.getByLabel('Stage meshes/cave-entrance.mesh')).toBeChecked();

    // Then: the staged state survives a full refetch (compare change →
    // diff + status re-read), because it lives in Lore, not in the window
    await selectCompareEndpoint(review, 'target', 'Raise the pillar');
    await expect
      .poll(() => listedPaths(review), { timeout: 20_000 })
      .toEqual(['meshes/pillar.mesh']);
    await selectCompareEndpoint(review, 'target', 'working tree');
    await expect(review.getByLabel('Stage meshes/cave-entrance.mesh')).toBeChecked({
      timeout: 20_000,
    });

    // And: unstaging survives the same round trip
    await unstageFileRow(review, 'meshes/cave-entrance.mesh');
    await expect(review.getByLabel('Stage meshes/cave-entrance.mesh')).not.toBeChecked();
    await selectCompareEndpoint(review, 'target', 'Raise the pillar');
    await selectCompareEndpoint(review, 'target', 'working tree');
    await expect(review.getByLabel('Stage meshes/cave-entrance.mesh')).not.toBeChecked({
      timeout: 20_000,
    });

    // When: the edit is staged again and committed, then pushed
    await stageFileRow(review, 'meshes/cave-entrance.mesh');
    await expect(review.getByLabel('Stage meshes/cave-entrance.mesh')).toBeChecked();
    await commitFromReview(review, 'Bump the cave entrance vertex count');
    await pushFromReview(review);

    // Then: a second, independent client syncing the branch really sees it —
    // the only honest proof the push reached the server.
    const user2 = await secondClient(server, repo.url, 'reviewer2');
    await expect
      .poll(
        async () => {
          try {
            return await user2.syncAndRead('meshes/cave-entrance.mesh');
          } catch {
            return '';
          }
        },
        { timeout: 60_000 }
      )
      .toBe(EDITED_MESH);

    await exitProjectView(window);

    // And: the footer's always-visible opener reaches the same view — even
    // now, with more dirty files than the one just committed remaining.
    await openProjectViewFromFooter(window);
    await expect(review.getByLabel('Commit message')).toBeVisible({ timeout: 20_000 });

    // And: the TitleBar control collapses straight down to the ambient pill.
    await collapseFromProjectView(window);
  });

  test('an unresolved conflict refuses staging in the review file list and on the card', async ({
    window,
    electronApp,
    server,
  }) => {
    // Given: a checkout with a local, UNPUSHED commit on a file a second
    // client then pushes an overlapping edit to — the exact overlap the
    // divergence-and-conflict integration scenario proves the SDK surfaces as
    // a pending merge with flagConflictUnresolved.
    const repoName = 'review-conflict';
    const conflictPath = 'meshes/cave-entrance.mesh';
    const repo = await seedRepo(server, repoName, { [conflictPath]: INITIAL_MESH });
    await connect(window, server.grpcUrl);
    const { clonePath } = await addAndClone(window, electronApp, repoName);

    await writeInClone(clonePath, { [conflictPath]: 'mesh-format-v1\nvertices: 999\n' });
    await refreshWorkingSet(window);
    await openWorkingSet(window);
    await toggleStage(window, conflictPath);
    await expect(workingSetRow(window, conflictPath)).toBeChecked();
    await commit(window, 'local vertex bump, deliberately not pushed');

    // And: a second client pushes its own edit to the same region first
    const user2 = await secondClient(server, repo.url, 'conflictor');
    await user2.commitAndPush(
      { [conflictPath]: 'mesh-format-v1\nvertices: 500\n' },
      'another author edits the same region, pushed first'
    );

    // When: this checkout syncs, the server hands back a pending merge
    await refreshWorkingSet(window);
    await syncToLatest(window);

    // Then: the card's working set replaces the row's checkbox with the ⚠
    // treatment — the file cannot be staged until the conflict is resolved.
    await expect(window.getByLabel('Conflicted — cannot stage until resolved')).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByLabel(conflictPath)).toHaveCount(0);

    // And: the review window's file list gives the same file the same
    // treatment (deep per-surface coverage lives in jest)
    const review = await openProjectView(window, 'Review');
    await expect(review.getByLabel(`${conflictPath} has an unresolved conflict`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(review.getByLabel(`Stage ${conflictPath}`)).toHaveCount(0);

    await exitProjectView(window);
  });
});
