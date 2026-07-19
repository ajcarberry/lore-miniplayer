import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlayerHeader } from '../../src/renderer/components/PlayerHeader';
import type { Repository } from '../../src/shared/types';
import { makeRepository } from '../mocks/repository-fixture';

const repository = makeRepository();

function renderHeader(
  colorScheme: 'light' | 'dark' = 'light',
  repo: Repository | null = repository
): { onOpenSwitcher: jest.Mock; unmount: () => void } {
  const onOpenSwitcher = jest.fn();
  const { unmount } = render(
    (
      <MantineProvider defaultColorScheme={colorScheme}>
        <PlayerHeader repository={repo} branchName='main' onOpenSwitcher={onOpenSwitcher} />
      </MantineProvider>
    ) as ReactElement
  );
  return { onOpenSwitcher, unmount };
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
    renderHeader('light', null);

    // Then: the static label stands in for the missing repo name
    expect(screen.getByText('On branch')).toBeInTheDocument();
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
    const { unmount } = renderHeader('dark');

    // Then: the white variant is selected
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'white');
    unmount();

    // When: rendering in light mode
    renderHeader('light');

    // Then: the black variant is selected
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'black');
  });
});
