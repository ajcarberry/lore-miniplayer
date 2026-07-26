import {
  test,
  expect,
  useLiveServer,
  connect,
  addAndClone,
  writeInClone,
  loreInClone,
} from './support/ui';
import { seedRepo } from './live-server.setup';

// The history constellation's fork visualization against the real app and a
// real `loreserver`: create a branch off main and commit to it, then assert
// WHICH main revision the branch is drawn as forking from. The scenario needs
// TWO commits on main before the branch exists — with only one, the repo root
// IS the fork and a mis-anchored fork (the regression: pairing the parent's
// branch point with the child lane's oldest node) is indistinguishable from a
// correct one. Requires `pnpm build` first.
test.describe.configure({ timeout: 240_000, retries: 1 });

test.describe('Live timeline — branch fork constellation', () => {
  useLiveServer();

  test('the fork anchors at the same main revision on both lanes', async ({
    window,
    electronApp,
    server,
    homeDir,
  }) => {
    // Given: main with two commits (r1 the root, r2 the tip)…
    const repoName = 'timeline-fork';
    const repo = await seedRepo(server, repoName, { 'notes.txt': 'alpha\n' });
    await writeInClone(repo.workdir, { 'notes.txt': 'alpha\nbravo\n' });
    await server.lore(['stage', '.', '--scan', '--repository', repo.workdir]);
    await server.lore(['commit', 'Second on main', '--repository', repo.workdir]);
    await server.lore(['push', '--repository', repo.workdir]);

    await connect(window, server.grpcUrl);
    const { clonePath } = await addAndClone(window, electronApp, repoName);

    // …and a branch created at main's tip (r2) carrying one commit (r3),
    // made out-of-band through the real CLI; the card's local-state watcher
    // picks up the switch and renders the two-lane constellation.
    await loreInClone(homeDir, clonePath, ['branch', 'create', 'feat/fork']);
    await loreInClone(homeDir, clonePath, ['branch', 'switch', 'feat/fork']);
    await writeInClone(clonePath, { 'branch.txt': 'work\n' });
    await loreInClone(homeDir, clonePath, ['stage', '.', '--scan'], ['commit', 'First on branch']);

    // When: the constellation shows the branch's own commit (the graph has
    // settled on the final shape)
    await expect(window.getByRole('button', { name: 'Select revision r3' })).toBeVisible({
      timeout: 60_000,
    });

    // Then: the fork connector is vertical… (toBeAttached, not toBeVisible: a
    // vertical line's zero-width bounding box reads as hidden)
    const connector = window.getByTestId('branch-connector');
    await expect(connector).toBeAttached();
    const forkX = await connector.getAttribute('x1');
    expect(await connector.getAttribute('x2')).toBe(forkX);

    // …the parent lane renders BOTH main revisions (the trunk, not a single
    // collapsed fork node), with its branch-point node (r=2.5) at the fork x…
    await expect(window.locator('g[data-revision] > circle')).toHaveCount(2);
    expect(await window.locator("circle[r='2.5']").getAttribute('cx')).toBe(forkX);

    // …and on the child lane it is r2 — main's tip, the revision the branch
    // was created off — that sits under the fork, NOT the repo root r1 (the
    // regression drew the fork over the oldest child node).
    const childCx = async (label: string): Promise<string | null> =>
      window.locator(`g[aria-label='${label}'] > circle`).first().getAttribute('cx');
    expect(await childCx('Select revision r2')).toBe(forkX);
    expect(await childCx('Select revision r1')).not.toBe(forkX);
  });
});
