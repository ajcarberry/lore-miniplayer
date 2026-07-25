import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttentionChip } from '../../src/renderer/components/AttentionChip';
import { renderWithMantine } from './test-utils';

function renderChip(props: Partial<Parameters<typeof AttentionChip>[0]> = {}): {
  onOpen: jest.Mock;
} {
  const onOpen = jest.fn();
  renderWithMantine(<AttentionChip needsYouCount={0} activeCount={0} onOpen={onOpen} {...props} />);
  return { onOpen };
}

describe('AttentionChip', () => {
  it('renders nothing when nothing needs attention and nothing is active', () => {
    // When: both counts are zero (all workspaces idle)
    renderChip({ needsYouCount: 0, activeCount: 0 });

    // Then: no chip renders at all
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the amber needs-you chip with its count, taking priority over active', () => {
    // Given: some workspaces need attention while others are merely active
    renderChip({ needsYouCount: 2, activeCount: 3 });

    // Then: the amber chip renders with the needsYou count, not the active one
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText('2 workspaces need you — open Mission Control')
    ).toBeInTheDocument();
  });

  it('uses singular phrasing for exactly one workspace needing you', () => {
    // When: only one workspace needs attention
    renderChip({ needsYouCount: 1, activeCount: 0 });

    // Then: the label is grammatically singular
    expect(
      screen.getByLabelText('1 workspace needs you — open Mission Control')
    ).toBeInTheDocument();
  });

  it('shows the quiet play chip with the active count when nothing needs you', () => {
    // Given: agents working, nothing needs the human
    renderChip({ needsYouCount: 0, activeCount: 3 });

    // Then: the hairline play chip renders with the active count
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByLabelText('3 agents working, none need you')).toBeInTheDocument();
  });

  it('uses singular phrasing for exactly one active agent', () => {
    // When: exactly one workspace is quietly active
    renderChip({ needsYouCount: 0, activeCount: 1 });

    // Then: the label is grammatically singular
    expect(screen.getByLabelText('1 agent working, none need you')).toBeInTheDocument();
  });

  it('invokes onOpen and stops propagation when clicked', async () => {
    // Given: a needs-you chip nested inside a clickable ancestor, mirroring
    // how the pill/card wrap the chip (clicking the pill/header otherwise
    // expands the card / opens the branch switcher)
    const user = userEvent.setup();
    const onOpen = jest.fn();
    const outerClick = jest.fn();
    renderWithMantine(
      <div onClick={outerClick}>
        <AttentionChip needsYouCount={1} activeCount={0} onOpen={onOpen} />
      </div>
    );

    // When: clicking the chip
    await user.click(screen.getByLabelText('1 workspace needs you — open Mission Control'));

    // Then: onOpen fires and the click never reaches the ancestor
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(outerClick).not.toHaveBeenCalled();
  });
});
