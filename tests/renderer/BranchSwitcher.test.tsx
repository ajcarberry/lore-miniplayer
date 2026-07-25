import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BranchSwitcher } from '../../src/renderer/components/BranchSwitcher';
import type { LoreBranch } from '../../src/shared/types';
import { renderWithMantine } from './test-utils';

const branches: LoreBranch[] = [
  { name: 'main', isDefault: true, isCurrent: true },
  { name: 'feature', isDefault: false, isCurrent: false },
];

interface RenderOptions {
  readonly branches?: LoreBranch[];
  readonly currentBranch?: string;
  readonly isLoading?: boolean;
}

function renderSwitcher(options: RenderOptions = {}): {
  onSelect: jest.Mock;
  onReload: jest.Mock;
} {
  const onSelect = jest.fn();
  const onReload = jest.fn();
  renderWithMantine(
    <BranchSwitcher
      branches={options.branches ?? branches}
      currentBranch={options.currentBranch ?? 'main'}
      isLoading={options.isLoading ?? false}
      onSelect={onSelect}
      onReload={onReload}
    >
      {onOpenSwitcher => (
        <button type='button' onClick={onOpenSwitcher}>
          trigger
        </button>
      )}
    </BranchSwitcher>
  );
  return { onSelect, onReload };
}

describe('BranchSwitcher', () => {
  it('stays closed until the target opens it', () => {
    // When: rendering without interaction
    renderSwitcher();

    // Then: the branch list is not shown
    expect(screen.queryByText('feature')).not.toBeInTheDocument();
  });

  it('reloads and lists branches, marking the current one, when opened', async () => {
    // Given: the switcher's target
    const user = userEvent.setup();
    const { onReload } = renderSwitcher();

    // When: opening it
    await user.click(screen.getByText('trigger'));

    // Then: branches are reloaded and both branches are listed, current marked
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('feature')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('current')).toBeInTheDocument();
  });

  it('picks a branch: calls setCurrentBranch and closes the popover', async () => {
    // Given: the switcher open
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher();
    await user.click(screen.getByText('trigger'));

    // When: picking a different branch
    await user.click(await screen.findByText('feature'));

    // Then: the selection is reported and the popover closes without
    // switching immediately (the caller/useSyncActions owns that guard)
    expect(onSelect).toHaveBeenCalledWith('feature');
    await waitFor(() => expect(screen.queryByText('feature')).not.toBeInTheDocument());
  });

  it('filters the branch list by search text', async () => {
    // Given: the switcher open
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByText('trigger'));

    // When: typing a search term
    await user.type(await screen.findByPlaceholderText('Search branches...'), 'feat');

    // Then: only the matching branch is shown
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  it('shows a loading state while branches load', async () => {
    // Given: branches still loading
    const user = userEvent.setup();
    renderSwitcher({ isLoading: true });

    // When: opening the switcher
    await user.click(screen.getByText('trigger'));

    // Then: the loading placeholder is shown
    expect(await screen.findByText('Loading branches...')).toBeInTheDocument();
  });
});
