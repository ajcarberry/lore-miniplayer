import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommitDialog } from '../../src/renderer/components/CommitDialog';
import type { CommitDialogProps } from '../../src/renderer/components/CommitDialog';
import { renderWithMantine } from './test-utils';

function baseProps(overrides: Partial<CommitDialogProps> = {}): CommitDialogProps {
  return {
    opened: true,
    branchName: 'main',
    stagedCount: 2,
    message: '',
    onMessageChange: jest.fn(),
    onCancel: jest.fn(),
    onSubmit: jest.fn(),
    isCommitting: false,
    ...overrides,
  };
}

function renderDialog(props: CommitDialogProps): void {
  renderWithMantine(<CommitDialog {...props} />);
}

describe('CommitDialog', () => {
  it('shows the target branch in the section label', () => {
    // When: rendering opened for a branch
    renderDialog(baseProps({ branchName: 'feature/foo' }));

    // Then: the label names the branch
    expect(screen.getByText('Commit to feature/foo')).toBeInTheDocument();
  });

  it('shows the staged count in the textarea placeholder', () => {
    // When: rendering with 3 staged files
    renderDialog(baseProps({ stagedCount: 3 }));

    // Then: the placeholder mentions the count
    expect(screen.getByPlaceholderText('3 staged files')).toBeInTheDocument();
  });

  it('shows the keyboard hint and disables Commit when the message is empty', () => {
    // When: rendering with an empty message
    renderDialog(baseProps({ message: '' }));

    // Then: the hint is shown and Commit is disabled
    expect(screen.getByText('⌘⏎ to commit')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('enables Commit once a message is entered', () => {
    // When: rendering with a non-empty message
    renderDialog(baseProps({ message: 'Fix the thing' }));

    // Then: Commit is enabled
    expect(screen.getByRole('button', { name: 'Commit' })).not.toBeDisabled();
  });

  it('reports message changes as the user types', async () => {
    // Given: an empty dialog
    const user = userEvent.setup();
    const onMessageChange = jest.fn();
    renderDialog(baseProps({ message: '', onMessageChange }));

    // When: typing in the textarea
    await user.type(screen.getByRole('textbox'), 'x');

    // Then: the change is reported
    expect(onMessageChange).toHaveBeenCalledWith('x');
  });

  it('calls onCancel when Cancel is clicked', async () => {
    // Given: an opened dialog
    const user = userEvent.setup();
    const onCancel = jest.fn();
    renderDialog(baseProps({ onCancel }));

    // When: clicking Cancel
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Then: cancel fires
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on Escape', async () => {
    // Given: an opened dialog
    const user = userEvent.setup();
    const onCancel = jest.fn();
    renderDialog(baseProps({ onCancel }));

    // When: pressing Escape
    await user.keyboard('{Escape}');

    // Then: cancel fires
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmit on Cmd/Ctrl+Enter when the message is non-empty', async () => {
    // Given: a dialog with a message
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    renderDialog(baseProps({ message: 'Fix the thing', onSubmit }));

    // When: pressing Ctrl+Enter in the textarea
    screen.getByRole('textbox').focus();
    await user.keyboard('{Control>}{Enter}{/Control}');

    // Then: submit fires
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not call onSubmit on Cmd/Ctrl+Enter when the message is empty', async () => {
    // Given: a dialog with an empty message
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    renderDialog(baseProps({ message: '', onSubmit }));

    // When: pressing Ctrl+Enter in the textarea
    screen.getByRole('textbox').focus();
    await user.keyboard('{Control>}{Enter}{/Control}');

    // Then: submit does not fire
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit when the Commit button is clicked', async () => {
    // Given: a dialog with a message
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    renderDialog(baseProps({ message: 'Fix the thing', onSubmit }));

    // When: clicking Commit
    await user.click(screen.getByRole('button', { name: 'Commit' }));

    // Then: submit fires
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows a busy state and disables Cancel/Commit while committing', () => {
    // When: rendering mid-commit
    renderDialog(baseProps({ message: 'Fix the thing', isCommitting: true }));

    // Then: both buttons are disabled
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it('renders nothing visible when not opened', () => {
    // When: rendering closed
    renderDialog(baseProps({ opened: false }));

    // Then: the dialog content is not in the document
    expect(screen.queryByText('Commit to main')).not.toBeInTheDocument();
  });
});
