import {
  test,
  expect,
  useLiveServer,
  connect,
  addAndClone,
  repoHeaderName,
  historyEmpty,
} from './support/ui';
import { seedRepo, sampleFiles } from './live-server.setup';

// Repository-lifecycle scenarios driven entirely through the support/ui helper
// layer against a real `loreserver`. UA is the WP-U2 smoke that proves the
// helper module + fixture; WP-U3 adds UB/UC here. Requires `pnpm build` first.

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
});
