import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdleWorkspaceRow } from '../../../src/renderer/components/mission-control/IdleWorkspaceRow';
import { makeWorkspace, renderWithMantine } from './fixtures';

describe('IdleWorkspaceRow', () => {
  it('reveals the worktree path on the branch and dispatches its three actions', async () => {
    const user = userEvent.setup();
    const workspace = makeWorkspace({ branchName: 'spike/old-fog', path: '/wt/old-fog' });
    const onOpenTerminal = jest.fn();
    const onTeardown = jest.fn();
    const onMarkActive = jest.fn();

    renderWithMantine(
      <IdleWorkspaceRow
        workspace={workspace}
        onOpenTerminal={onOpenTerminal}
        onTeardown={onTeardown}
        onMarkActive={onMarkActive}
      />
    );

    expect(screen.getByText('spike/old-fog')).toHaveAttribute('title', '/wt/old-fog');

    await user.click(screen.getByRole('button', { name: 'Mark active' }));
    expect(onMarkActive).toHaveBeenCalledWith(workspace);

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(onOpenTerminal).toHaveBeenCalledWith('/wt/old-fog');

    await user.click(screen.getByRole('button', { name: /Close workspace/ }));
    expect(onTeardown).toHaveBeenCalledWith(workspace);
  });
});
