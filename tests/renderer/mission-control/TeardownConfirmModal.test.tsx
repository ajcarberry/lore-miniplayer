import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeardownConfirmModal } from '../../../src/renderer/components/mission-control/TeardownConfirmModal';
import type { TeardownConfirmModalProps } from '../../../src/renderer/components/mission-control/TeardownConfirmModal';
import { makeWorkspace, renderWithMantine } from './fixtures';

function baseProps(overrides: Partial<TeardownConfirmModalProps> = {}): TeardownConfirmModalProps {
  return {
    opened: true,
    workspace: makeWorkspace(),
    requiresForce: false,
    isRepoCheckout: false,
    isTearingDown: false,
    onClose: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides,
  };
}

describe('TeardownConfirmModal', () => {
  it('states exactly what is removed, including that the remote branch is not', () => {
    renderWithMantine(<TeardownConfirmModal {...baseProps()} />);

    expect(screen.getByText(/the worktree directory/)).toBeInTheDocument();
    expect(screen.getByText('the local branch (archived)')).toBeInTheDocument();
    expect(screen.getByText(/remote branch is not removed/i)).toBeInTheDocument();
  });

  it('confirms directly (force false) when there is no uncommitted/unpushed work', async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    renderWithMantine(<TeardownConfirmModal {...baseProps({ requiresForce: false, onConfirm })} />);

    expect(screen.queryByLabelText(/Force close/)).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Close workspace' });
    expect(confirm).not.toBeDisabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('gates the confirm behind the force checkbox when work would be discarded', async () => {
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    renderWithMantine(<TeardownConfirmModal {...baseProps({ requiresForce: true, onConfirm })} />);

    const confirm = screen.getByRole('button', { name: 'Close workspace' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByLabelText('Force close and discard this work'));
    expect(confirm).not.toBeDisabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('always gates the confirm behind a checkbox for a repository checkout, even when clean', async () => {
    // Given: an attached/cloned target with no dirty/unpushed work at all
    // (requiresForce false) — the repo-checkout requirement is independent
    const user = userEvent.setup();
    const onConfirm = jest.fn();
    renderWithMantine(
      <TeardownConfirmModal
        {...baseProps({ requiresForce: false, isRepoCheckout: true, onConfirm })}
      />
    );

    // Then: the dirty/unpushed alert does not appear, but the confirm is
    // still disabled until the repository-checkout checkbox is checked
    expect(screen.queryByLabelText('Force close and discard this work')).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Close workspace' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByLabelText('Confirm closing this repository checkout'));
    expect(confirm).not.toBeDisabled();

    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('cancels without confirming', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const onConfirm = jest.fn();
    renderWithMantine(<TeardownConfirmModal {...baseProps({ onClose, onConfirm })} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
