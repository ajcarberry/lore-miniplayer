import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdleWorkspaceRow } from '../../../src/renderer/components/mission-control/IdleWorkspaceRow';
import { makeWorkspace, renderWithMantine } from './fixtures';

describe('IdleWorkspaceRow', () => {
  it('reveals the worktree path on the branch and dispatches its four actions', async () => {
    const user = userEvent.setup();
    const workspace = makeWorkspace({ branchName: 'spike/old-fog', path: '/wt/old-fog' });
    const onOpenTerminal = jest.fn();
    const onTeardown = jest.fn();
    const onMarkActive = jest.fn();
    const onForget = jest.fn();

    renderWithMantine(
      <IdleWorkspaceRow
        workspace={workspace}
        isActive={false}
        onOpenTerminal={onOpenTerminal}
        onTeardown={onTeardown}
        onMarkActive={onMarkActive}
        onForget={onForget}
      />
    );

    expect(screen.getByText('spike/old-fog')).toHaveAttribute('title', '/wt/old-fog');
    expect(screen.queryByText('active')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark active' }));
    expect(onMarkActive).toHaveBeenCalledWith(workspace);

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(onOpenTerminal).toHaveBeenCalledWith('/wt/old-fog');

    await user.click(screen.getByRole('button', { name: /Forget workspace/ }));
    expect(onForget).toHaveBeenCalledWith(workspace);

    await user.click(screen.getByRole('button', { name: /Close workspace/ }));
    expect(onTeardown).toHaveBeenCalledWith(workspace);
  });

  it('marks the active row with a badge and disables its ✕ and Forget actions', () => {
    const workspace = makeWorkspace({ branchName: 'main' });

    renderWithMantine(
      <IdleWorkspaceRow
        workspace={workspace}
        isActive
        onOpenTerminal={jest.fn()}
        onTeardown={jest.fn()}
        onMarkActive={jest.fn()}
        onForget={jest.fn()}
      />
    );

    expect(screen.getByText('active')).toBeInTheDocument();
    const closeButton = screen.getByRole('button', { name: /Close workspace/ });
    const forgetButton = screen.getByRole('button', { name: /Forget workspace/ });
    expect(closeButton).toBeDisabled();
    expect(forgetButton).toBeDisabled();
    expect(closeButton).toHaveAttribute('title', expect.stringContaining('currently in'));
    expect(forgetButton).toHaveAttribute('title', expect.stringContaining('currently in'));
  });

  it('shows the registry name as a muted suffix when it differs from the branch', () => {
    // Given: two attached workspaces of one repo can share a branch name
    // ("adfa") while being registered under distinct names.
    const workspace = makeWorkspace({ branchName: 'adfa', name: 'personal-test' });

    renderWithMantine(
      <IdleWorkspaceRow
        workspace={workspace}
        isActive={false}
        onOpenTerminal={jest.fn()}
        onTeardown={jest.fn()}
        onMarkActive={jest.fn()}
        onForget={jest.fn()}
      />
    );

    expect(screen.getByText('adfa')).toBeInTheDocument();
    expect(screen.getByText('· personal-test')).toBeInTheDocument();
  });

  it('suppresses the suffix when the name is redundant with the branch', () => {
    // Given: a provisioned worktree's registry name is a sanitized version of
    // its branch (slashes replaced with hyphens) — the same idea, spelling
    // aside, so no suffix should render.
    const workspace = makeWorkspace({ branchName: 'test/WT1', name: 'test-WT1' });

    renderWithMantine(
      <IdleWorkspaceRow
        workspace={workspace}
        isActive={false}
        onOpenTerminal={jest.fn()}
        onTeardown={jest.fn()}
        onMarkActive={jest.fn()}
        onForget={jest.fn()}
      />
    );

    expect(screen.getByText('test/WT1')).toBeInTheDocument();
    expect(screen.queryByText('· test-WT1')).not.toBeInTheDocument();
  });
});
