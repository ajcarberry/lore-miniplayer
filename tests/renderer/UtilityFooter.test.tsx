import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UtilityFooter } from '../../src/renderer/components/UtilityFooter';
import type { Repository } from '../../src/shared/types';
import { installMockElectronAPI } from '../mocks/electron-api';
import { makeRepository } from '../mocks/repository-fixture';

// Popover/Menu open involves a floating-ui position calculation; under heavy
// parallel test load this occasionally exceeds Jest's default 5s test
// timeout even though the interaction itself is correct (verified stable
// across 20 standalone runs) — give these tests headroom to match the
// generous per-query timeout used below.
jest.setTimeout(15000);

interface RenderOptions {
  readonly selectedRepo?: Repository | null;
  readonly repositories?: Repository[];
  readonly serverUrl?: string | null;
  readonly onSelectRepo?: jest.Mock;
  readonly onAddRepo?: jest.Mock;
  readonly onEditRepo?: jest.Mock;
  readonly onRefreshRepos?: jest.Mock;
  readonly onChangeServer?: jest.Mock;
  readonly onOpenMissionControl?: jest.Mock;
}

function renderFooter(options: RenderOptions = {}): {
  onSelectRepo: jest.Mock;
  onAddRepo: jest.Mock;
  onEditRepo: jest.Mock;
  onRefreshRepos: jest.Mock;
  onChangeServer: jest.Mock;
  onOpenMissionControl: jest.Mock;
} {
  const onSelectRepo = options.onSelectRepo ?? jest.fn();
  const onAddRepo = options.onAddRepo ?? jest.fn();
  const onEditRepo = options.onEditRepo ?? jest.fn();
  const onRefreshRepos = options.onRefreshRepos ?? jest.fn();
  const onChangeServer = options.onChangeServer ?? jest.fn();
  const onOpenMissionControl = options.onOpenMissionControl ?? jest.fn();

  render(
    (
      <MantineProvider>
        <UtilityFooter
          selectedRepo={options.selectedRepo ?? null}
          repositories={options.repositories ?? []}
          isLoadingRepos={false}
          onSelectRepo={onSelectRepo}
          onAddRepo={onAddRepo}
          onEditRepo={onEditRepo}
          onRefreshRepos={onRefreshRepos}
          serverUrl={options.serverUrl ?? 'lores://lore.example.com'}
          onChangeServer={onChangeServer}
          onOpenMissionControl={onOpenMissionControl}
        />
      </MantineProvider>
    ) as ReactElement
  );

  return {
    onSelectRepo,
    onAddRepo,
    onEditRepo,
    onRefreshRepos,
    onChangeServer,
    onOpenMissionControl,
  };
}

describe('UtilityFooter', () => {
  let api: ReturnType<typeof installMockElectronAPI>;

  beforeEach(() => {
    api = installMockElectronAPI();
  });

  describe('action guards with no repository selected', () => {
    it('should not open the file explorer', async () => {
      // Given: no selected repository
      const user = userEvent.setup();
      renderFooter({ selectedRepo: null });

      // When: clicking Open in File Explorer
      await user.click(screen.getByRole('button', { name: 'Open in File Explorer' }));

      // Then: the electron API is never invoked
      expect(api.repository.openInExplorer).not.toHaveBeenCalled();
    });

    it('should not open a terminal', async () => {
      // Given: no selected repository
      const user = userEvent.setup();
      renderFooter({ selectedRepo: null });

      // When: clicking Open Terminal here
      await user.click(screen.getByRole('button', { name: 'Open Terminal here' }));

      // Then: the electron API is never invoked
      expect(api.window.openTerminal).not.toHaveBeenCalled();
    });

    it('should not open Mission Control', async () => {
      // Given: no selected repository
      const user = userEvent.setup();
      const { onOpenMissionControl } = renderFooter({ selectedRepo: null });

      // When: clicking Mission Control
      await user.click(screen.getByRole('button', { name: 'Mission Control' }));

      // Then: the callback is never invoked
      expect(onOpenMissionControl).not.toHaveBeenCalled();
    });
  });

  describe('action buttons with a repository selected', () => {
    it('should open the repository in the file explorer', async () => {
      // Given: a selected repository
      const user = userEvent.setup();
      renderFooter({ selectedRepo: makeRepository() });

      // When: clicking Open in File Explorer
      await user.click(screen.getByRole('button', { name: 'Open in File Explorer' }));

      // Then: the explorer is opened at the repository's local path
      await waitFor(() =>
        expect(api.repository.openInExplorer).toHaveBeenCalledWith('/tmp/my-repo')
      );
    });

    it('should open a terminal at the repository path', async () => {
      // Given: a selected repository
      const user = userEvent.setup();
      renderFooter({ selectedRepo: makeRepository() });

      // When: clicking Open Terminal here
      await user.click(screen.getByRole('button', { name: 'Open Terminal here' }));

      // Then: the terminal is opened at the repository's local path
      await waitFor(() => expect(api.window.openTerminal).toHaveBeenCalledWith('/tmp/my-repo'));
    });

    it('should open Mission Control', async () => {
      // Given: a selected repository
      const user = userEvent.setup();
      const { onOpenMissionControl } = renderFooter({ selectedRepo: makeRepository() });

      // When: clicking Mission Control
      await user.click(screen.getByRole('button', { name: 'Mission Control' }));

      // Then: the callback fires
      expect(onOpenMissionControl).toHaveBeenCalledTimes(1);
    });
  });

  describe('repository picker popover', () => {
    it('should select a repository from the list', async () => {
      // Given: two repositories
      const repoA = makeRepository({ name: 'Alpha' });
      const repoB = makeRepository({ id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c', name: 'Beta' });
      const user = userEvent.setup();
      const { onSelectRepo } = renderFooter({ selectedRepo: repoA, repositories: [repoA, repoB] });

      // When: opening the repository picker and choosing Beta
      await user.click(screen.getByRole('button', { name: 'Workspaces' }));
      await user.click(await screen.findByText('Beta', {}, { timeout: 8000 }));

      // Then: the selection callback fires with the chosen repository
      expect(onSelectRepo).toHaveBeenCalledWith(repoB);
    });

    it('should open the add-repository flow', async () => {
      // Given: the repository picker
      const user = userEvent.setup();
      const { onAddRepo } = renderFooter();

      // When: opening the picker and choosing Add workspace…
      await user.click(screen.getByRole('button', { name: 'Workspaces' }));
      await user.click(await screen.findByText('Add workspace…', {}, { timeout: 8000 }));

      // Then: the add-repository callback fires
      expect(onAddRepo).toHaveBeenCalled();
    });

    it('should list a provisioned workspace with a repo-name-prefixed display name', async () => {
      // Given: a card-view repo and a provisioned worktree of the same repo
      const attached = makeRepository({ name: 'MyRepo' });
      const provisioned = makeRepository({
        id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
        origin: 'provisioned',
        name: 'test-WT1',
        url: 'lores://lore.example.com/demo-project',
        branchName: 'test/WT1',
        localPath: '/tmp/wt/test-WT1',
      });
      const user = userEvent.setup();
      const { onSelectRepo } = renderFooter({
        selectedRepo: attached,
        repositories: [attached, provisioned],
      });

      // When: opening the picker
      await user.click(screen.getByRole('button', { name: 'Workspaces' }));

      // Then: the provisioned entry reads "<repo name> · <branch>", legible
      // alongside its card-view sibling, and selecting it fires the callback
      await user.click(await screen.findByText('demo-project · test/WT1', {}, { timeout: 8000 }));
      expect(onSelectRepo).toHaveBeenCalledWith(provisioned);
    });

    it('should open the edit flow for a repository row', async () => {
      // Given: a repository in the list
      const repo = makeRepository();
      const user = userEvent.setup();
      const { onEditRepo } = renderFooter({ selectedRepo: repo, repositories: [repo] });

      // When: opening the picker and clicking the row's edit action
      // (role queries exclude elements the popover's floating-ui positioning
      // pass is still transitioning through display:none for, unlike text
      // queries — wait for row content by text first, then query the edit
      // button with hidden:true so it isn't excluded by that transient state)
      await user.click(screen.getByRole('button', { name: 'Workspaces' }));
      await screen.findByText('MyRepo', {}, { timeout: 8000 });
      await user.click(
        await screen.findByRole('button', { name: 'Edit MyRepo', hidden: true }, { timeout: 8000 })
      );

      // Then: the edit callback fires with that repository
      expect(onEditRepo).toHaveBeenCalledWith(repo);
    });

    it('should refresh the repository list', async () => {
      // Given: the repository picker
      const user = userEvent.setup();
      const { onRefreshRepos } = renderFooter();

      // When: opening the picker and clicking Refresh
      await user.click(screen.getByRole('button', { name: 'Workspaces' }));
      await user.click(await screen.findByText('Refresh', {}, { timeout: 8000 }));

      // Then: the refresh callback fires
      expect(onRefreshRepos).toHaveBeenCalled();
    });
  });

  describe('server popover', () => {
    it('should change the server', async () => {
      // Given: a connected server
      const user = userEvent.setup();
      const { onChangeServer } = renderFooter({ serverUrl: 'lores://lore.example.com' });

      // When: opening the server popover and choosing Change server…
      await user.click(screen.getByRole('button', { name: 'Server' }));
      expect(
        await screen.findByText('lores://lore.example.com', {}, { timeout: 8000 })
      ).toBeInTheDocument();
      await user.click(screen.getByText('Change server…'));

      // Then: the change-server callback fires
      expect(onChangeServer).toHaveBeenCalled();
    });
  });

  describe('theme toggle', () => {
    it('should persist the chosen theme mode via config', async () => {
      // Given: the footer with the default (auto) theme mode loaded
      const user = userEvent.setup();
      renderFooter();
      await waitFor(() => expect(api.config.get).toHaveBeenCalled());

      // When: opening the theme menu and choosing Dark
      await user.click(screen.getByRole('button', { name: 'Theme' }));
      await user.click(await screen.findByText('Dark', {}, { timeout: 8000 }));

      // Then: the theme mode is persisted through the config IPC
      await waitFor(() => expect(api.config.set).toHaveBeenCalledWith({ themeMode: 'dark' }));
    });
  });
});
