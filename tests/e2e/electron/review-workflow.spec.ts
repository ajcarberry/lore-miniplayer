import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchApp, removeTempUserDataDir } from './launch';
import type { ReviewOpenRequest } from '../../../src/shared/types';

// Requires `pnpm build` first — launches the built app at out/main/index.js.
//
// Exercises the reviewIntent seam directly: `window.electronAPI.review.open`
// is the exact call `requestOpenReviewWindow` (mission-control/reviewIntent.ts)
// makes from Mission Control's Review / Commit / Merge buttons, so invoking it
// from the test with a fabricated `ReviewOpenRequest` reaches the real IPC
// handler and window (src/main/ipc/window-handlers.ts's registerReviewWindow)
// without needing a live workspace card to click through. `ReviewWindow.tsx`
// routes purely on `request.workflow` ('commit' | 'merge'), independent of
// whether the underlying repository/diff calls succeed — so a workspacePath
// that isn't a real Lore repository is enough to prove the routing without a
// live server: the commit view always renders its bottom bar, and the merge
// view surfaces its own "could not start" error state for a non-repository
// path rather than silently falling back to the commit view.

function makeWorkspaceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-miniplayer-e2e-review-'));
}

test.describe('Review window — reviewIntent seam routing', () => {
  test('a commit-workflow request opens the commit view', async () => {
    const workspacePath = makeWorkspaceDir();
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    const request: ReviewOpenRequest = {
      workspacePath,
      repositoryId: randomUUID(),
      branchName: 'agent/my-task',
      workflow: 'commit',
      compare: {
        source: { kind: 'branchHead', branch: 'agent/my-task' },
        target: { kind: 'workingTree' },
      },
    };

    const [reviewWindow] = await Promise.all([
      electronApp.waitForEvent('window'),
      // `window` here is the Playwright Page (see launchApp's return), so the
      // evaluate callback reaches the page's global via globalThis rather than
      // shadowing it with that same name (mirrors card-anatomy.spec.ts).
      window.evaluate(req => globalThis.window.electronAPI.review.open(req), request),
    ]);

    // The commit workflow's contextual primary action (design 2b) always
    // renders, regardless of whether the diff/status fetches against the
    // fixture path succeed.
    await expect(reviewWindow.getByLabel('Commit message')).toBeVisible();
    await expect(reviewWindow.getByRole('button', { name: 'Commit' })).toBeVisible();
    // The merge workflow's bar never appears for a commit-mode request.
    await expect(reviewWindow.getByRole('button', { name: 'Merge' })).toHaveCount(0);

    await reviewWindow.close();
    await electronApp.close();
    removeTempUserDataDir(userDataDir);
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('a merge-workflow request opens the merge view', async () => {
    const workspacePath = makeWorkspaceDir();
    const { app: electronApp, userDataDir } = await launchApp();
    const window = await electronApp.firstWindow();

    const request: ReviewOpenRequest = {
      workspacePath,
      repositoryId: randomUUID(),
      branchName: 'agent/my-task',
      workflow: 'merge',
      compare: {
        source: { kind: 'branchHead', branch: 'agent/my-task' },
        target: { kind: 'branchHead', branch: 'main' },
      },
    };

    const [reviewWindow] = await Promise.all([
      electronApp.waitForEvent('window'),
      window.evaluate(req => globalThis.window.electronAPI.review.open(req), request),
    ]);

    // The fixture path is not a real Lore repository, so the merge bridge
    // fails fast — the merge view's own error state proves routing landed on
    // MergeView (never CommitReview, which has no such state at all).
    await expect(reviewWindow.getByText('Could not start the merge')).toBeVisible();
    await expect(reviewWindow.getByLabel('Commit message')).toHaveCount(0);

    await reviewWindow.close();
    await electronApp.close();
    removeTempUserDataDir(userDataDir);
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
});
