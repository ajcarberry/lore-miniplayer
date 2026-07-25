import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Transport } from '../../src/renderer/components/Transport';
import type { TransportProps } from '../../src/renderer/components/Transport';
import { renderWithMantine } from './test-utils';

function baseProps(overrides: Partial<TransportProps> = {}): TransportProps {
  return {
    mode: 'normal',
    sync: {
      label: 'Sync',
      sub: 'Current',
      busy: false,
      disabled: false,
      accented: false,
      onClick: jest.fn(),
      menu: { onSyncToRevision: jest.fn(), onReset: jest.fn() },
    },
    commit: { count: 0, disabled: false, busy: false, accented: false, onClick: jest.fn() },
    push: { sub: '—', disabled: false, busy: false, accented: false, onClick: jest.fn() },
    clone: { busy: false, onClick: jest.fn() },
    ...overrides,
  };
}

function renderTransport(props: TransportProps): void {
  renderWithMantine(<Transport {...props} />);
}

describe('Transport', () => {
  it('renders Sync/Commit/Push with clean-state captions in normal mode, and no Stage button', () => {
    // When: rendering with the default (nothing staged, unknown divergence) props
    renderTransport(baseProps());

    // Then: all three cells and their idle captions are shown
    expect(screen.getByText('Sync')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Commit')).toBeInTheDocument();
    expect(screen.getByText('Push')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    // And: the Stage button is gone
    expect(screen.queryByText('Stage')).not.toBeInTheDocument();
  });

  it('shows the switch & sync sub-caption when a different branch is targeted', () => {
    // Given: the caller has computed a branch-switch target
    const props = baseProps({ sync: { ...baseProps().sync, sub: 'Switch & sync' } });

    // When: rendering
    renderTransport(props);

    // Then: the sync caption reflects it
    expect(screen.getByText('Switch & sync')).toBeInTheDocument();
  });

  it('shows the staged count in the sub-caption only, with no count badge', () => {
    // Given: staged files present
    const props = baseProps({
      commit: { count: 2, disabled: false, busy: false, accented: true, onClick: jest.fn() },
    });

    // When: rendering
    renderTransport(props);

    // Then: the caption carries the count; there is no separate badge circle
    expect(screen.getByText('2 staged')).toBeInTheDocument();
    expect(screen.queryByText('2', { exact: true })).not.toBeInTheDocument();
  });

  it('shows the push sub-caption reflecting divergence', () => {
    // Given: the branch has commits ready to push
    const props = baseProps({
      push: { sub: 'To push', disabled: false, busy: false, accented: true, onClick: jest.fn() },
    });

    // When: rendering
    renderTransport(props);

    // Then: the push caption reflects it
    expect(screen.getByText('To push')).toBeInTheDocument();
  });

  it('fires the sync/commit/push callbacks when clicked', async () => {
    // Given: a rendered transport
    const user = userEvent.setup();
    const props = baseProps();
    renderTransport(props);

    // When: clicking each cell
    await user.click(screen.getByText('Sync'));
    await user.click(screen.getByText('Commit'));
    await user.click(screen.getByText('Push'));

    // Then: each cell's onClick fires exactly once
    expect(props.sync.onClick).toHaveBeenCalledTimes(1);
    expect(props.commit.onClick).toHaveBeenCalledTimes(1);
    expect(props.push.onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no cell as accented when nothing needs the action (all flags false)', () => {
    // Given: default props (nothing staged, no sync/push action pending)
    renderTransport(baseProps());

    // Then: none of the three cells carry the accent data attribute
    expect(screen.getByText('Sync').closest('button')).not.toHaveAttribute('data-primary');
    expect(screen.getByText('Commit').closest('button')).not.toHaveAttribute('data-primary');
    expect(screen.getByText('Push').closest('button')).not.toHaveAttribute('data-primary');
  });

  it('accents Sync only when its accented flag is set', () => {
    // Given: Sync is the one action available (e.g. behind remote)
    const props = baseProps({ sync: { ...baseProps().sync, accented: true } });

    // When: rendering
    renderTransport(props);

    // Then: only Sync carries the accent
    expect(screen.getByText('Sync').closest('button')).toHaveAttribute('data-primary', 'true');
    expect(screen.getByText('Commit').closest('button')).not.toHaveAttribute('data-primary');
    expect(screen.getByText('Push').closest('button')).not.toHaveAttribute('data-primary');
  });

  it('accents Commit only when its accented flag is set', () => {
    // Given: files are staged
    const props = baseProps({
      commit: { count: 1, disabled: false, busy: false, accented: true, onClick: jest.fn() },
    });

    // When: rendering
    renderTransport(props);

    // Then: only Commit carries the accent
    expect(screen.getByText('Commit').closest('button')).toHaveAttribute('data-primary', 'true');
    expect(screen.getByText('Sync').closest('button')).not.toHaveAttribute('data-primary');
    expect(screen.getByText('Push').closest('button')).not.toHaveAttribute('data-primary');
  });

  it('accents Push only when its accented flag is set', () => {
    // Given: local is ahead of the remote
    const props = baseProps({
      push: { sub: 'To push', disabled: false, busy: false, accented: true, onClick: jest.fn() },
    });

    // When: rendering
    renderTransport(props);

    // Then: only Push carries the accent
    expect(screen.getByText('Push').closest('button')).toHaveAttribute('data-primary', 'true');
    expect(screen.getByText('Sync').closest('button')).not.toHaveAttribute('data-primary');
    expect(screen.getByText('Commit').closest('button')).not.toHaveAttribute('data-primary');
  });

  it('always accents Clone in clone mode, regardless of other flags', () => {
    // Given: clone mode
    const props = baseProps({ mode: 'clone' });

    // When: rendering
    renderTransport(props);

    // Then: Clone carries the accent
    expect(screen.getByText('Clone').closest('button')).toHaveAttribute('data-primary', 'true');
  });

  it('opens the sync split menu without triggering sync, and fires its actions', async () => {
    // Given: a rendered transport
    const user = userEvent.setup();
    const props = baseProps();
    renderTransport(props);

    // When: opening the sync menu and choosing Sync to Revision
    await user.click(screen.getByRole('button', { name: 'More sync options' }));
    await user.click(await screen.findByText('Sync to Revision…'));

    // Then: only the menu action fires, not the main sync action
    expect(props.sync.menu.onSyncToRevision).toHaveBeenCalledTimes(1);
    expect(props.sync.onClick).not.toHaveBeenCalled();

    // When: opening the menu again and choosing Reset
    await user.click(screen.getByRole('button', { name: 'More sync options' }));
    await user.click(await screen.findByText('Reset'));

    // Then: the reset action fires
    expect(props.sync.menu.onReset).toHaveBeenCalledTimes(1);
  });

  it('disables sync/commit/push per their disabled flags', () => {
    // Given: all three cells disabled
    const props = baseProps({
      sync: { ...baseProps().sync, disabled: true },
      commit: { count: 0, disabled: true, busy: false, accented: false, onClick: jest.fn() },
      push: { sub: '—', disabled: true, busy: false, accented: false, onClick: jest.fn() },
    });

    // When: rendering
    renderTransport(props);

    // Then: each cell's button is disabled
    expect(screen.getByText('Sync').closest('button')).toBeDisabled();
    expect(screen.getByText('Commit').closest('button')).toBeDisabled();
    expect(screen.getByText('Push').closest('button')).toBeDisabled();
  });

  it('shows a loader and disables the cell while sync is busy', () => {
    // Given: sync in progress
    const props = baseProps({ sync: { ...baseProps().sync, busy: true } });

    // When: rendering
    renderTransport(props);

    // Then: the sync cell is disabled while busy
    expect(screen.getByText('Sync').closest('button')).toBeDisabled();
  });

  it('replaces the primary slot with Clone and force-disables Commit when not yet cloned', () => {
    // Given: clone mode (repository not yet on disk)
    const props = baseProps({ mode: 'clone' });

    // When: rendering
    renderTransport(props);

    // Then: Clone takes the primary slot; Commit is force-disabled and Push is gone
    expect(screen.getByText('Clone')).toBeInTheDocument();
    expect(screen.getByText('Commit').closest('button')).toBeDisabled();
    expect(screen.queryByText('Push')).not.toBeInTheDocument();
  });

  it('fires clone.onClick when Clone is pressed', async () => {
    // Given: clone mode
    const user = userEvent.setup();
    const props = baseProps({ mode: 'clone' });
    renderTransport(props);

    // When: clicking Clone
    await user.click(screen.getByText('Clone'));

    // Then: the clone callback fires
    expect(props.clone.onClick).toHaveBeenCalledTimes(1);
  });
});
