jest.mock('../../src/renderer/utils/notify', () => ({
  notifyError: jest.fn(),
  notifySuccess: jest.fn(),
}));

import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MiniPlayer } from '../../src/renderer/components/MiniPlayer';
import { notifyError } from '../../src/renderer/utils/notify';
import { installMockElectronAPI } from '../mocks/electron-api';
import { makeRepository } from '../mocks/repository-fixture';

// Popover/Menu open involves a floating-ui position calculation; under heavy
// parallel test load this occasionally exceeds Jest's default 5s test
// timeout even though the interaction itself is correct — give these tests
// headroom to match the generous per-query timeout used below.
jest.setTimeout(15000);

const SERVER_ADDRESS_STORAGE_KEY = 'lore-server-address';

function renderMiniPlayer(): ReturnType<typeof render> {
  return render((<MantineProvider>{<MiniPlayer />}</MantineProvider>) as ReactElement);
}

describe('MiniPlayer', () => {
  let api: ReturnType<typeof installMockElectronAPI>;

  beforeEach(() => {
    localStorage.clear();
    api = installMockElectronAPI();
  });

  describe('connect page', () => {
    it('should show the server address input when no server is stored', () => {
      // When: rendering with no stored address
      renderMiniPlayer();

      // Then: the connect page is shown with a disabled Connect button
      expect(screen.getByPlaceholderText('lores://lore.example.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    });

    it('should default a bare address to the TLS scheme and persist it', async () => {
      // Given: the connect page
      const user = userEvent.setup();
      renderMiniPlayer();

      // When: entering an address without a scheme and connecting
      await user.type(screen.getByPlaceholderText('lores://lore.example.com'), 'lore.example.com');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      // Then: the repository view is shown and the normalized address persisted
      expect(await screen.findByText('On branch')).toBeInTheDocument();
      expect(localStorage.getItem(SERVER_ADDRESS_STORAGE_KEY)).toBe('lores://lore.example.com');
    });

    it('should keep an explicit plaintext scheme as entered', async () => {
      // Given: the connect page
      const user = userEvent.setup();
      renderMiniPlayer();

      // When: entering a plaintext local server address
      await user.type(screen.getByPlaceholderText('lores://lore.example.com'), 'lore://127.0.0.1');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      // Then: the scheme is preserved
      expect(await screen.findByText('On branch')).toBeInTheDocument();
      expect(localStorage.getItem(SERVER_ADDRESS_STORAGE_KEY)).toBe('lore://127.0.0.1');
    });

    it('should not connect on Enter with an empty address', async () => {
      // Given: the connect page
      const user = userEvent.setup();
      renderMiniPlayer();

      // When: pressing Enter in the empty input
      await user.type(screen.getByPlaceholderText('lores://lore.example.com'), '{Enter}');

      // Then: still on the connect page, nothing stored
      expect(screen.getByPlaceholderText('lores://lore.example.com')).toBeInTheDocument();
      expect(localStorage.getItem(SERVER_ADDRESS_STORAGE_KEY)).toBeNull();
    });
  });

  describe('connected view', () => {
    beforeEach(() => {
      localStorage.setItem(SERVER_ADDRESS_STORAGE_KEY, 'lore.example.com');
    });

    it('should skip the connect page and load repositories', async () => {
      // When: rendering with a stored server address
      renderMiniPlayer();

      // Then: the repository view is shown and repositories are loaded
      expect(await screen.findByText('On branch')).toBeInTheDocument();
      await waitFor(() => expect(api.repository.list).toHaveBeenCalled());
      expect(screen.queryByPlaceholderText('lores://lore.example.com')).not.toBeInTheDocument();
    });

    it('should select the first repository and load its branches', async () => {
      // Given: one stored repository with branches
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });

      // When: rendering
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');

      // Then: the first repository is auto-selected and its branches loaded
      // (waited on first — clicking mid-auto-selection races the re-render
      // and can drop the popover toggle)
      await waitFor(() =>
        expect(api.lore.repository.listBranches).toHaveBeenCalledWith('/tmp/my-repo')
      );
      await waitFor(() =>
        expect(api.lore.repository.checkStatus).toHaveBeenCalledWith('/tmp/my-repo')
      );

      // Then: the picker's dropdown lists it (scoped to the dropdown — the
      // name also appears in the header eyebrow, which must not satisfy this
      // assertion). hidden:true keeps the role query from excluding the
      // dropdown while floating-ui's positioning pass transitions it through
      // display:none under parallel test load.
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
      const picker = await screen.findByRole('dialog', { hidden: true }, { timeout: 8000 });
      expect(await within(picker).findByText('MyRepo')).toBeInTheDocument();
    });

    it('morphs the card into the Project View from the footer opener and back', async () => {
      // Given: a connected card with a selected repository
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });
      Object.assign(api, {
        diff: { compare: jest.fn().mockResolvedValue({ success: true, data: [] }) },
      });

      const user = userEvent.setup();
      const { container } = renderMiniPlayer();
      await screen.findByText('On branch');
      await waitFor(() => expect(api.lore.repository.listBranches).toHaveBeenCalled());

      // When: opening from the always-visible footer icon
      await user.click(screen.getByRole('button', { name: 'Open Project View' }));

      // Then: the card morphs into the commit review surface and the window
      // grows to the review footprint
      expect(await screen.findByText('Review — main')).toBeInTheDocument();
      expect(api.window.setView).toHaveBeenCalledWith('projectView');
      expect(container.querySelector("[data-project-view='true']")).not.toBeNull();

      // When: backing out via the surface's header control
      await user.click(screen.getByLabelText('Back'));

      // Then: the surface fades out and, after the fold, the window returns
      // to the card footprint
      expect(container.querySelector("[data-project-view='true']")).toBeNull();
      await waitFor(() => expect(api.window.setView).toHaveBeenCalledWith('card'));
    });

    it("should apply the selected repository's accent as inline CSS vars", async () => {
      // Given: a stored repository with the verdigris accent
      const repo = makeRepository({ accentHue: 172 });
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });

      // When: rendering
      const { container } = renderMiniPlayer();
      await screen.findByText('On branch');

      // Then: once the first repository auto-selects, the root card carries
      // its accent ramp as CSS vars ('On branch' renders before selection
      // resolves, so wait on the accent-carrying element itself)
      await waitFor(() => {
        const card = container.querySelector('[style*="--acc"]');
        expect(card?.getAttribute('style')).toContain('--acc: oklch(0.66 0.11 172)');
      });

      // And: the collapsed pill carries the same accent — its signal glyphs
      // read in the selected repository's color, not the token default
      await waitFor(() => {
        const pillWrap = container.querySelector('.morph-pill');
        expect(pillWrap?.getAttribute('style')).toContain('--acc: oklch(0.66 0.11 172)');
      });
    });

    it('should apply the dark accent ramp when the dark color scheme is active', async () => {
      // Given: a stored repository with the verdigris accent
      const repo = makeRepository({ accentHue: 172 });
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });

      // When: rendering under the dark color scheme
      const { container } = render(
        (
          <MantineProvider forceColorScheme='dark'>{<MiniPlayer />}</MantineProvider>
        ) as ReactElement
      );
      await screen.findByText('On branch');

      // Then: the card carries the dark ramp — the light ramp's near-white
      // --acc-soft would wash selected history rows with a light background
      // under light ink, making their text unreadable on dark paper
      await waitFor(() => {
        const card = container.querySelector('[style*="--acc"]');
        expect(card?.getAttribute('style')).toContain('--acc-soft: oklch(0.38 0.06 172)');
      });

      // And: the collapsed pill picks up the same dark ramp
      await waitFor(() => {
        const pillWrap = container.querySelector('.morph-pill');
        expect(pillWrap?.getAttribute('style')).toContain('--acc-soft: oklch(0.38 0.06 172)');
      });
    });

    it('should offer Clone for a repository that is not checked out yet', async () => {
      // Given: a stored repository whose path is not a working copy
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.checkStatus as jest.Mock).mockResolvedValue({
        success: true,
        data: { exists: false, isLoreRepo: false },
      });

      // When: rendering and cloning
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      await user.click(await screen.findByText('Clone'));

      // Then: the clone is requested with the repository url and path
      await waitFor(() =>
        expect(api.lore.repository.clone).toHaveBeenCalledWith(
          'lore.example.com/MyRepo',
          '/tmp/my-repo'
        )
      );
    });

    it('should sync an existing working copy', async () => {
      // Given: a stored repository that is already checked out
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });

      // When: rendering and syncing
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('Current');
      await waitFor(() => expect(screen.getByText('Sync').closest('button')).not.toBeDisabled());
      await user.click(screen.getByText('Sync'));

      // Then: the current branch is synced without a branch switch
      await waitFor(() =>
        expect(api.lore.repository.sync).toHaveBeenCalledWith('/tmp/my-repo', undefined)
      );
    });

    it('should commit staged files via the in-card commit dialog, without pushing', async () => {
      // Given: a checked-out repository with one staged file
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.files.getStatus as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          untracked: [],
          unstaged: [],
          staged: [{ path: 'file.txt', isUntracked: false, isModified: true, isStaged: true }],
        },
      });

      // When: opening the commit dialog from the transport
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      await user.click(await screen.findByText('Commit'));

      // Then: the dialog opens naming the current branch and staged count
      expect(await screen.findByText('Commit to main')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('1 staged file')).toBeInTheDocument();

      // When: writing a message and committing
      await user.type(screen.getByPlaceholderText('1 staged file'), 'My change');
      await user.click(screen.getByRole('button', { name: 'Commit' }));

      // Then: the commit is requested with the message, the dialog closes,
      // and push is never invoked
      await waitFor(() =>
        expect(api.lore.repository.commit).toHaveBeenCalledWith('/tmp/my-repo', 'My change')
      );
      await waitFor(() => expect(screen.queryByText('Commit to main')).not.toBeInTheDocument());
      expect(api.lore.repository.push).not.toHaveBeenCalled();
    });

    it('should refresh branch divergence and branch graph after a successful commit', async () => {
      // Given: a checked-out repository with one staged file
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });
      (api.lore.files.getStatus as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          untracked: [],
          unstaged: [],
          staged: [{ path: 'file.txt', isUntracked: false, isModified: true, isStaged: true }],
        },
      });

      // When: committing via the in-card dialog
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      // Wait for the initial branch-divergence/history fetches (fired once the
      // repository auto-selects) before snapshotting call counts, so the
      // "before" baseline isn't taken mid-flight.
      await waitFor(() => expect(api.lore.branchInfo as jest.Mock).toHaveBeenCalled());
      await waitFor(() => expect(api.lore.branchGraph as jest.Mock).toHaveBeenCalled());
      const branchInfoCallsBeforeCommit = (api.lore.branchInfo as jest.Mock).mock.calls.length;
      const graphCallsBeforeCommit = (api.lore.branchGraph as jest.Mock).mock.calls.length;
      await user.click(await screen.findByText('Commit'));
      await screen.findByText('Commit to main');
      await user.type(screen.getByPlaceholderText('1 staged file'), 'My change');
      await user.click(screen.getByRole('button', { name: 'Commit' }));

      // Then: branch divergence and branch graph are both refetched after
      // the commit succeeds (the History section must not keep showing the
      // pre-commit revision list)
      await waitFor(() =>
        expect((api.lore.branchInfo as jest.Mock).mock.calls.length).toBeGreaterThan(
          branchInfoCallsBeforeCommit
        )
      );
      await waitFor(() =>
        expect((api.lore.branchGraph as jest.Mock).mock.calls.length).toBeGreaterThan(
          graphCallsBeforeCommit
        )
      );
    });

    it('should push via the Push transport cell, without committing, and refresh divergence', async () => {
      // Given: a checked-out repository with nothing staged
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });

      // When: clicking the Push cell
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      // Wait for the initial branch-divergence fetch (fired once the
      // repository auto-selects) before snapshotting the call count, so the
      // "before" baseline isn't taken mid-flight.
      await waitFor(() => expect(api.lore.branchInfo as jest.Mock).toHaveBeenCalled());
      const branchInfoCallsBeforePush = (api.lore.branchInfo as jest.Mock).mock.calls.length;
      await waitFor(() => expect(screen.getByText('Push').closest('button')).not.toBeDisabled());
      await user.click(screen.getByText('Push'));

      // Then: only push is requested, and divergence is refetched afterward
      await waitFor(() => expect(api.lore.repository.push).toHaveBeenCalledWith('/tmp/my-repo'));
      expect(api.lore.repository.commit).not.toHaveBeenCalled();
      await waitFor(() =>
        expect((api.lore.branchInfo as jest.Mock).mock.calls.length).toBeGreaterThan(
          branchInfoCallsBeforePush
        )
      );
    });

    it('should expand the working set instead of opening the dialog when nothing is staged', async () => {
      // Given: a checked-out repository with an unstaged file and nothing staged
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.files.getStatus as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          untracked: [],
          unstaged: [
            { path: 'changed.txt', isUntracked: false, isModified: true, isStaged: false },
          ],
          staged: [],
        },
      });

      // When: clicking Commit with nothing staged
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      await user.click(await screen.findByText('Commit'));

      // Then: the working set expands to show the unstaged file instead of
      // the commit dialog opening
      expect(await screen.findByText('changed.txt')).toBeInTheDocument();
      expect(screen.queryByText('Commit to main')).not.toBeInTheDocument();
    });

    it('should switch branches and sync when a different branch is chosen', async () => {
      // Given: a repository on main with another branch available
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [
          { name: 'main', isDefault: true, isCurrent: true },
          { name: 'feature', isDefault: false, isCurrent: false },
        ],
      });

      // When: opening the branch switcher and choosing the feature branch
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('Current');
      await user.click(screen.getByRole('button', { name: 'Switch branch' }));
      await user.click(await screen.findByText('feature'));

      // Then: the sync cell becomes "Switch & sync" and syncs to the target branch
      await screen.findByText('Switch & sync');
      await waitFor(() => expect(screen.getByText('Sync').closest('button')).not.toBeDisabled());
      await user.click(screen.getByText('Sync'));
      await waitFor(() =>
        expect(api.lore.repository.sync).toHaveBeenCalledWith('/tmp/my-repo', 'feature')
      );
    });

    it('should sync to a specific revision through the menu', async () => {
      // Given: a checked-out repository
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });

      // When: opening the sync options menu and choosing Sync to Revision
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('Current');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'More sync options' })).not.toBeDisabled()
      );
      await user.click(screen.getByRole('button', { name: 'More sync options' }));
      await user.click(await screen.findByText('Sync to Revision…'));

      // And: entering a revision and syncing
      await user.type(await screen.findByLabelText('Revision'), '@7');
      await user.click(screen.getByRole('button', { name: 'Sync to Revision' }));

      // Then: the sync is requested with the revision options
      await waitFor(() =>
        expect(api.lore.repository.sync).toHaveBeenCalledWith('/tmp/my-repo', undefined, {
          revision: '@7',
          forwardChanges: false,
        })
      );
    });

    it('should reset the repository after confirmation', async () => {
      // Given: a checked-out repository on main
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });

      // When: choosing Reset from the menu and confirming
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('Current');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'More sync options' })).not.toBeDisabled()
      );
      await user.click(screen.getByRole('button', { name: 'More sync options' }));
      await user.click(await screen.findByText('Reset'));
      await user.click(await screen.findByRole('button', { name: 'Reset Repository' }));

      // Then: a forced reset sync to the current branch is requested
      await waitFor(() =>
        expect(api.lore.repository.sync).toHaveBeenCalledWith('/tmp/my-repo', 'main', {
          reset: true,
          force: true,
        })
      );
    });

    it('should refresh branch divergence and branch graph after a successful sync', async () => {
      // Given: a checked-out repository
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });

      // When: syncing the current branch
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('Current');
      // Wait for the initial branch-divergence/history fetches before
      // snapshotting call counts, so the "before" baseline isn't mid-flight.
      await waitFor(() => expect(api.lore.branchInfo as jest.Mock).toHaveBeenCalled());
      await waitFor(() => expect(api.lore.branchGraph as jest.Mock).toHaveBeenCalled());
      const branchInfoCallsBeforeSync = (api.lore.branchInfo as jest.Mock).mock.calls.length;
      const graphCallsBeforeSync = (api.lore.branchGraph as jest.Mock).mock.calls.length;
      await waitFor(() => expect(screen.getByText('Sync').closest('button')).not.toBeDisabled());
      await user.click(screen.getByText('Sync'));
      await waitFor(() =>
        expect(api.lore.repository.sync).toHaveBeenCalledWith('/tmp/my-repo', undefined)
      );

      // Then: both branch divergence and branch graph are refetched
      await waitFor(() =>
        expect((api.lore.branchInfo as jest.Mock).mock.calls.length).toBeGreaterThan(
          branchInfoCallsBeforeSync
        )
      );
      await waitFor(() =>
        expect((api.lore.branchGraph as jest.Mock).mock.calls.length).toBeGreaterThan(
          graphCallsBeforeSync
        )
      );
    });

    it('should refresh branch divergence and branch graph after a successful reset', async () => {
      // Given: a checked-out repository on main
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
        success: true,
        data: [{ name: 'main', isDefault: true, isCurrent: true }],
      });

      // When: choosing Reset from the menu and confirming
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('Current');
      // Wait for the initial branch-divergence/history fetches before
      // snapshotting call counts, so the "before" baseline isn't mid-flight.
      await waitFor(() => expect(api.lore.branchInfo as jest.Mock).toHaveBeenCalled());
      await waitFor(() => expect(api.lore.branchGraph as jest.Mock).toHaveBeenCalled());
      const branchInfoCallsBeforeReset = (api.lore.branchInfo as jest.Mock).mock.calls.length;
      const graphCallsBeforeReset = (api.lore.branchGraph as jest.Mock).mock.calls.length;
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'More sync options' })).not.toBeDisabled()
      );
      await user.click(screen.getByRole('button', { name: 'More sync options' }));
      await user.click(await screen.findByText('Reset'));
      await user.click(await screen.findByRole('button', { name: 'Reset Repository' }));

      // Then: both branch divergence and branch graph are refetched
      await waitFor(() =>
        expect((api.lore.branchInfo as jest.Mock).mock.calls.length).toBeGreaterThan(
          branchInfoCallsBeforeReset
        )
      );
      await waitFor(() =>
        expect((api.lore.branchGraph as jest.Mock).mock.calls.length).toBeGreaterThan(
          graphCallsBeforeReset
        )
      );
    });

    it('should stage a file clicked in the working set', async () => {
      // Given: a repository with one unstaged file
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.lore.files.getStatus as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          untracked: [],
          unstaged: [
            { path: 'changed.txt', isUntracked: false, isModified: true, isStaged: false },
          ],
          staged: [],
        },
      });

      // When: opening the working set and clicking the file
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      await user.click(await screen.findByText('Working Set'));
      await user.click(await screen.findByText('changed.txt'));

      // Then: the file is staged using its repo-relative path (the main
      // process joins it against the repository path)
      await waitFor(() =>
        expect(api.lore.files.stage).toHaveBeenCalledWith('/tmp/my-repo', ['changed.txt'])
      );
    });

    it('should open the repository in the file explorer and terminal', async () => {
      // Given: a selected repository
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });

      // When: using the quick action buttons
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      await user.click(screen.getByRole('button', { name: 'Open in File Explorer' }));
      await user.click(screen.getByRole('button', { name: 'Open Terminal here' }));

      // Then: both actions target the repository path
      expect(api.repository.openInExplorer).toHaveBeenCalledWith('/tmp/my-repo');
      expect(api.window.openTerminal).toHaveBeenCalledWith('/tmp/my-repo');
    });

    it('should surface a failed repository update as an error notification', async () => {
      // Given: one stored repository whose update will fail
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.repository.update as jest.Mock).mockResolvedValue({
        success: false,
        error: 'config store is locked',
      });

      // When: renaming the repository through the edit modal
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
      const picker = await screen.findByRole('dialog', { hidden: true }, { timeout: 8000 });
      await user.click(
        await within(picker).findByRole('button', { name: 'Edit MyRepo', hidden: true })
      );
      await user.type(await screen.findByLabelText(/Repository Name/), '2');
      await user.click(screen.getByRole('button', { name: 'Save Changes' }));

      // Then: the failure is surfaced to the user, not just logged
      await waitFor(() =>
        expect(notifyError).toHaveBeenCalledWith(
          'Update Repository Failed',
          'config store is locked'
        )
      );
    });

    it('should surface a failed repository delete as an error notification', async () => {
      // Given: one stored repository whose delete will fail
      const repo = makeRepository();
      (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
      (api.repository.delete as jest.Mock).mockResolvedValue({
        success: false,
        error: 'config store is locked',
      });

      // When: deleting the repository through the edit modal
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
      const picker = await screen.findByRole('dialog', { hidden: true }, { timeout: 8000 });
      await user.click(
        await within(picker).findByRole('button', { name: 'Edit MyRepo', hidden: true })
      );
      await user.click(await screen.findByRole('button', { name: 'Delete Repository' }));
      await user.click(await screen.findByRole('button', { name: 'Remove from Lore' }));

      // Then: the failure is surfaced to the user, not just logged
      await waitFor(() =>
        expect(notifyError).toHaveBeenCalledWith(
          'Delete Repository Failed',
          'config store is locked'
        )
      );
    });

    it('should return to the connect page via the change-server button', async () => {
      // Given: the connected view
      const user = userEvent.setup();
      renderMiniPlayer();
      await screen.findByText('On branch');

      // When: opening the server popover and clicking Change server…
      await user.click(screen.getByRole('button', { name: 'Server' }));
      await user.click(await screen.findByText('Change server…'));

      // Then: the connect page is shown again, prefilled with the last address
      const input = await screen.findByPlaceholderText('lores://lore.example.com');
      expect(input).toHaveValue('lore.example.com');
    });

    it('starts collapsed, expands on a pill click, and collapses via the title bar', async () => {
      // Given: the connected view (starts as the ambient pill)
      const user = userEvent.setup();
      const { container } = renderMiniPlayer();
      await screen.findByText('On branch');
      const expanded = (): string | null | undefined =>
        container.querySelector('.morph-root')?.getAttribute('data-expanded');
      expect(expanded()).toBe('false');

      // When: clicking the pill
      const pill = container.querySelector('.morph-pill');
      await user.click(pill as Element);

      // Then: the card expands
      await waitFor(() => expect(expanded()).toBe('true'));

      // When: clicking the title bar's collapse-to-pill control
      await user.click(screen.getByRole('button', { name: 'Collapse to pill' }));

      // Then: it folds back to the pill
      await waitFor(() => expect(expanded()).toBe('false'));
    });

    describe('sync-needed notice', () => {
      it('reports an active notice to main when the branch falls behind the remote', async () => {
        // Given: a checked-out repository whose branch is behind the remote
        const repo = makeRepository();
        (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
        (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
          success: true,
          data: [{ name: 'main', isDefault: true, isCurrent: true }],
        });
        (api.lore.branchInfo as jest.Mock).mockResolvedValue({
          success: true,
          data: { state: 'behindOrDiverged', latest: 'aaa', latestRemote: 'bbb' },
        });

        // When: rendering the connected player
        renderMiniPlayer();
        await screen.findByText('On branch');

        // Then: the notice flag reaches main so the window skips blur dimming
        // and the pill's pulse stays visible while the user works elsewhere
        await waitFor(() => expect(api.window.setNoticeActive).toHaveBeenLastCalledWith(true));
      });

      it('keeps the notice clear while the workspace is in sync', async () => {
        // Given: a checked-out repository with no divergence (default mocks)
        const repo = makeRepository();
        (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
        (api.lore.repository.listBranches as jest.Mock).mockResolvedValue({
          success: true,
          data: [{ name: 'main', isDefault: true, isCurrent: true }],
        });

        // When: rendering the connected player
        renderMiniPlayer();
        await screen.findByText('On branch');
        await waitFor(() => expect(api.lore.branchInfo as jest.Mock).toHaveBeenCalled());

        // Then: the notice is reported inactive and never activated
        await waitFor(() => expect(api.window.setNoticeActive).toHaveBeenCalledWith(false));
        expect(api.window.setNoticeActive).not.toHaveBeenCalledWith(true);
      });
    });
  });
});
