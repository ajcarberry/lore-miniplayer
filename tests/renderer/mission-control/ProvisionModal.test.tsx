import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ProvisionModal,
  validateBranchName,
} from '../../../src/renderer/components/mission-control/ProvisionModal';
import type { ProvisionModalProps } from '../../../src/renderer/components/mission-control/ProvisionModal';
import { makeRepository, renderWithMantine } from './fixtures';

function baseProps(overrides: Partial<ProvisionModalProps> = {}): ProvisionModalProps {
  return {
    opened: true,
    repository: makeRepository(),
    baseBranch: 'main',
    isProvisioning: false,
    onClose: jest.fn(),
    onSubmit: jest.fn(),
    ...overrides,
  };
}

describe('validateBranchName', () => {
  it('requires a name, allows namespaced names, and rejects ".." segments', () => {
    expect(validateBranchName('   ')).toBe('Branch name is required');
    expect(validateBranchName('agent/act2-balance')).toBeNull();
    expect(validateBranchName('../escape')).toMatch(/segment/);
  });
});

describe('ProvisionModal', () => {
  it('shows the read-only base branch and a live worktree directory preview', async () => {
    const user = userEvent.setup();
    renderWithMantine(<ProvisionModal {...baseProps({ baseBranch: 'main' })} />);

    expect(screen.getByLabelText('Base branch')).toHaveValue('main');

    await user.type(screen.getByLabelText('New branch name'), 'agent/act2');
    expect(screen.getByText('/Users/rowan/work/emberfall-wt/agent/act2')).toBeInTheDocument();
  });

  it('rejects an empty name on submit and does not dispatch', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    renderWithMantine(<ProvisionModal {...baseProps({ onSubmit })} />);

    await user.click(screen.getByRole('button', { name: 'Provision' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Branch name is required')).toBeInTheDocument();
  });

  it('submits the trimmed branch name', async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    renderWithMantine(<ProvisionModal {...baseProps({ onSubmit })} />);

    await user.type(screen.getByLabelText('New branch name'), '  agent/act2  ');
    await user.click(screen.getByRole('button', { name: 'Provision' }));

    expect(onSubmit).toHaveBeenCalledWith('agent/act2');
  });

  it('cancels without submitting', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderWithMantine(<ProvisionModal {...baseProps({ onClose })} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
