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
  readonly colorScheme?: 'light' | 'dark';
  readonly onSelectRepo?: jest.Mock;
  readonly onAddRepo?: jest.Mock;
  readonly onEditRepo?: jest.Mock;
  readonly onRefreshRepos?: jest.Mock;
  readonly onChangeServer?: jest.Mock;
  readonly onOpenProjectView?: jest.Mock;
}

function renderFooter(options: RenderOptions = {}): {
  onSelectRepo: jest.Mock;
  onAddRepo: jest.Mock;
  onEditRepo: jest.Mock;
  onRefreshRepos: jest.Mock;
  onChangeServer: jest.Mock;
  onOpenProjectView: jest.Mock;
} {
  const onSelectRepo = options.onSelectRepo ?? jest.fn();
  const onAddRepo = options.onAddRepo ?? jest.fn();
  const onEditRepo = options.onEditRepo ?? jest.fn();
  const onRefreshRepos = options.onRefreshRepos ?? jest.fn();
  const onChangeServer = options.onChangeServer ?? jest.fn();
  const onOpenProjectView = options.onOpenProjectView ?? jest.fn();

  render(
    (
      <MantineProvider {...(options.colorScheme ? { forceColorScheme: options.colorScheme } : {})}>
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
          onOpenProjectView={onOpenProjectView}
        />
      </MantineProvider>
    ) as ReactElement
  );

  return { onSelectRepo, onAddRepo, onEditRepo, onRefreshRepos, onChangeServer, onOpenProjectView };
}

describe('UtilityFooter', () => {
  let api: ReturnType<typeof installMockElectronAPI>;

  beforeEach(() => {
    api = installMockElectronAPI();
  });

  describe('action guards with no repository selected', () => {
    it('should not open the Project View', async () => {
      // Given: no selected repository
      const user = userEvent.setup();
      const { onOpenProjectView } = renderFooter({ selectedRepo: null });

      // When: clicking Review changes
      await user.click(screen.getByRole('button', { name: 'Open Project View' }));

      // Then: the opener never fires
      expect(onOpenProjectView).not.toHaveBeenCalled();
    });

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
  });

  describe('action buttons with a repository selected', () => {
    it('should always offer the Project View opener, left of the explorer shortcut', async () => {
      // Given: a selected repository
      const user = userEvent.setup();
      const { onOpenProjectView } = renderFooter({ selectedRepo: makeRepository() });

      // Then: the icon renders immediately before Open in File Explorer
      const buttons = screen.getAllByRole('button');
      const review = screen.getByRole('button', { name: 'Open Project View' });
      const explorer = screen.getByRole('button', { name: 'Open in File Explorer' });
      expect(buttons.indexOf(review)).toBe(buttons.indexOf(explorer) - 1);

      // When: clicking it
      await user.click(review);

      // Then: the opener fires
      expect(onOpenProjectView).toHaveBeenCalledTimes(1);
    });

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
  });

  describe('repository picker popover', () => {
    it('should select a repository from the list', async () => {
      // Given: two repositories
      const repoA = makeRepository({ name: 'Alpha' });
      const repoB = makeRepository({ id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c', name: 'Beta' });
      const user = userEvent.setup();
      const { onSelectRepo } = renderFooter({ selectedRepo: repoA, repositories: [repoA, repoB] });

      // When: opening the repository picker and choosing Beta
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
      await user.click(await screen.findByText('Beta', {}, { timeout: 8000 }));

      // Then: the selection callback fires with the chosen repository
      expect(onSelectRepo).toHaveBeenCalledWith(repoB);
    });

    it('should open the add-repository flow', async () => {
      // Given: the repository picker
      const user = userEvent.setup();
      const { onAddRepo } = renderFooter();

      // When: opening the picker and choosing Add repository…
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
      await user.click(await screen.findByText('Add repository…', {}, { timeout: 8000 }));

      // Then: the add-repository callback fires
      expect(onAddRepo).toHaveBeenCalled();
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
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
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
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
      await user.click(await screen.findByText('Refresh', {}, { timeout: 8000 }));

      // Then: the refresh callback fires
      expect(onRefreshRepos).toHaveBeenCalled();
    });
  });

  describe('repository accent dot', () => {
    it('should use the dark accent base for the dot in dark mode', async () => {
      // Given: a repository with the amber accent under the dark color scheme
      const repo = makeRepository();
      const user = userEvent.setup();
      renderFooter({ selectedRepo: repo, repositories: [repo], colorScheme: 'dark' });

      // When: opening the repository picker
      await user.click(screen.getByRole('button', { name: 'Repositories' }));
      await screen.findByText('MyRepo', {}, { timeout: 8000 });

      // Then: the row's dot carries the dark ramp base, not the light base
      const dot = document.querySelector('span[style*="background-color: oklch"]');
      expect(dot?.getAttribute('style')).toContain('oklch(0.74 0.12 74)');
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
