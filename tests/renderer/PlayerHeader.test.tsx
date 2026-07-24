import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerHeader } from '../../src/renderer/components/PlayerHeader';
import type { PlayerHeaderProps } from '../../src/renderer/components/PlayerHeader';
import { makeRepository } from '../mocks/repository-fixture';

const repository = makeRepository();

function renderHeader(
  overrides: Partial<PlayerHeaderProps> = {},
  colorScheme: 'light' | 'dark' = 'light'
): {
  onOpenSwitcher: jest.Mock;
  onOpenMissionControl: jest.Mock;
} & ReturnType<typeof render> {
  const onOpenSwitcher = jest.fn();
  const onOpenMissionControl = jest.fn();
  const props: PlayerHeaderProps = {
    repository,
    branchName: 'main',
    onOpenSwitcher,
    needsYouCount: 0,
    activeCount: 0,
    onOpenMissionControl,
    ...overrides,
  };
  const result = render(
    (
      <MantineProvider defaultColorScheme={colorScheme}>
        <PlayerHeader {...props} />
      </MantineProvider>
    ) as ReactElement
  );
  return { ...result, onOpenSwitcher, onOpenMissionControl };
}

describe('PlayerHeader', () => {
  it('shows the repository name as the eyebrow above the branch name', () => {
    // When: rendering with a selected repository and branch
    renderHeader();

    // Then: the repo name replaces the static "On branch" label
    expect(screen.getByText('MyRepo')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.queryByText('On branch')).not.toBeInTheDocument();
  });

  it('falls back to the on-branch label when no repository is selected', () => {
    // When: rendering without a repository
    renderHeader({ repository: null });

    // Then: the static label stands in for the missing repo name
    expect(screen.getByText('On branch')).toBeInTheDocument();
  });

  it('combines the repo name with the workspace name when it differs meaningfully', () => {
    // Given: an attached sibling workspace named "adfa" of repo
    // "demo-project", on a branch that is neither "adfa" nor "demo-project"
    const attachedSibling = makeRepository({
      name: 'adfa',
      url: 'lores://lore.example.com/demo-project',
    });

    // When: rendering the header for that workspace
    renderHeader({ repository: attachedSibling, branchName: 'main' });

    // Then: the eyebrow shows the repo name, not the bare workspace name
    expect(screen.getByText('demo-project · adfa')).toBeInTheDocument();
    expect(screen.queryByText('adfa')).not.toBeInTheDocument();
  });

  it('reveals the repository local path in a tooltip on the repo name', async () => {
    // Given: a rendered header with a repository
    const user = userEvent.setup();
    renderHeader();

    // When: hovering the repo name eyebrow
    await user.hover(screen.getByText('MyRepo'));

    // Then: the tooltip carries the local checkout path
    expect(await screen.findByText('/tmp/my-repo')).toBeInTheDocument();
  });

  it('opens the branch switcher when the header is clicked', async () => {
    // Given: a rendered header
    const user = userEvent.setup();
    const { onOpenSwitcher } = renderHeader();

    // When: clicking the header
    await user.click(screen.getByRole('button', { name: 'Switch branch' }));

    // Then: the open callback fires
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
  });

  it('opens the branch switcher with Enter and Space from the keyboard', async () => {
    // Given: a rendered header with the switcher button focused (the header
    // is a role='button' Box, not a native <button>, so keyboard activation
    // must be wired explicitly)
    const user = userEvent.setup();
    const { onOpenSwitcher } = renderHeader();
    screen.getByRole('button', { name: 'Switch branch' }).focus();

    // When: pressing Enter
    await user.keyboard('{Enter}');

    // Then: the open callback fires
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);

    // When: pressing Space
    await user.keyboard(' ');

    // Then: the open callback fires again
    expect(onOpenSwitcher).toHaveBeenCalledTimes(2);
  });

  it('carries no divergence badge — action state lives on the transport buttons', () => {
    // When: rendering the header
    renderHeader();

    // Then: none of the retired badge variants are present
    expect(screen.queryByLabelText('In sync')).not.toBeInTheDocument();
    expect(screen.queryByText('Ahead of remote')).not.toBeInTheDocument();
    expect(screen.queryByText('Behind remote')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Divergence unknown')).not.toBeInTheDocument();
  });

  it('renders the white logomark in dark mode and the black logomark in light mode', () => {
    // When: rendering in dark mode
    const { unmount } = renderHeader({}, 'dark');

    // Then: the white variant is selected
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'white');
    unmount();

    // When: rendering in light mode
    renderHeader({}, 'light');

    // Then: the black variant is selected
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'black');
  });

  it('no longer renders the chevron — the attention chip replaces it (design 1c)', () => {
    // When: rendering the header with no agent activity
    const { container } = renderHeader();

    // Then: no chevron icon renders (regression guard for the design's
    // header cleanup — chevron and watermark removed)
    expect(container.querySelector('svg.tabler-icon-chevron-down')).not.toBeInTheDocument();
  });

  describe('agent attention chip (design 1c)', () => {
    it('renders no chip when no workspace needs you and none are active', () => {
      // When: both counts are zero
      renderHeader({ needsYouCount: 0, activeCount: 0 });

      // Then: no attention chip renders
      expect(screen.queryByText(/need|working/)).not.toBeInTheDocument();
    });

    it('shows the needs-you count in the header row', () => {
      // When: one workspace needs the human
      renderHeader({ needsYouCount: 1, activeCount: 0 });

      // Then: the chip renders with its accessible label
      expect(
        screen.getByLabelText('1 workspace needs you — open Mission Control')
      ).toBeInTheDocument();
    });

    it('shows the active count when nothing needs you', () => {
      // When: agents working, nothing needs the human
      renderHeader({ needsYouCount: 0, activeCount: 4 });

      // Then: the play chip renders with its accessible label
      expect(screen.getByLabelText('4 agents working, none need you')).toBeInTheDocument();
    });

    it('opens Mission Control when the chip is clicked, without opening the branch switcher', async () => {
      // Given: a header with a needs-you chip
      const user = userEvent.setup();
      const { onOpenMissionControl, onOpenSwitcher } = renderHeader({ needsYouCount: 1 });

      // When: clicking the chip
      await user.click(screen.getByLabelText('1 workspace needs you — open Mission Control'));

      // Then: Mission Control opens and the branch switcher never does
      // (the chip stops propagation, mirroring the pill's close control)
      expect(onOpenMissionControl).toHaveBeenCalledTimes(1);
      expect(onOpenSwitcher).not.toHaveBeenCalled();
    });
  });
});
