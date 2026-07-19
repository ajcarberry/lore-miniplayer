import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevisionSyncModal } from '../../src/renderer/components/RevisionSyncModal';

function renderModal(): ReturnType<typeof render> & { onSync: jest.Mock; onClose: jest.Mock } {
  const onSync = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    (
      <MantineProvider>
        <RevisionSyncModal opened onClose={onClose} onSync={onSync} currentBranch='main' />
      </MantineProvider>
    ) as ReactElement
  );
  return { ...utils, onSync, onClose };
}

describe('RevisionSyncModal', () => {
  it('should show the current branch and disable sync with no revision', () => {
    // When: opening the modal
    renderModal();

    // Then: branch context is shown and the action is disabled
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync to Revision' })).toBeDisabled();
  });

  it('should sync with a shorthand revision number', async () => {
    // Given: the modal
    const user = userEvent.setup();
    const { onSync } = renderModal();

    // When: entering @2 and syncing
    await user.type(screen.getByLabelText('Revision'), '@2');
    await user.click(screen.getByRole('button', { name: 'Sync to Revision' }));

    // Then: onSync receives the revision without forwarding changes
    expect(onSync).toHaveBeenCalledWith({ revision: '@2', forwardChanges: false });
  });

  it('should pass keep-local-changes through as forwardChanges', async () => {
    // Given: the modal
    const user = userEvent.setup();
    const { onSync } = renderModal();

    // When: entering a hash and enabling keep local changes
    await user.type(screen.getByLabelText('Revision'), 'abc123def');
    await user.click(screen.getByLabelText('Keep local changes'));
    await user.click(screen.getByRole('button', { name: 'Sync to Revision' }));

    // Then: forwardChanges is set
    expect(onSync).toHaveBeenCalledWith({
      revision: 'abc123def',
      forwardChanges: true,
    });
  });

  it('should reject a short non-shorthand revision', async () => {
    // Given: the modal
    const user = userEvent.setup();
    const { onSync } = renderModal();

    // When: entering a five-character hash and syncing
    await user.type(screen.getByLabelText('Revision'), 'abc12');
    await user.click(screen.getByRole('button', { name: 'Sync to Revision' }));

    // Then: a validation error is shown and no sync happens
    expect(await screen.findByText(/at least 6 characters/)).toBeInTheDocument();
    expect(onSync).not.toHaveBeenCalled();
  });

  it('should reject a non-hex revision', async () => {
    // Given: the modal
    const user = userEvent.setup();
    const { onSync } = renderModal();

    // When: entering a non-hex value and syncing
    await user.type(screen.getByLabelText('Revision'), 'not-a-hash');
    await user.click(screen.getByRole('button', { name: 'Sync to Revision' }));

    // Then: a validation error is shown and no sync happens
    expect(await screen.findByText(/hex hash or revision number/)).toBeInTheDocument();
    expect(onSync).not.toHaveBeenCalled();
  });

  it('should prefill the revision field from initialRevision when opened', async () => {
    // Given: the modal opened with a prefilled revision hash
    const onSync = jest.fn();
    render(
      (
        <MantineProvider>
          <RevisionSyncModal
            opened
            onClose={jest.fn()}
            onSync={onSync}
            currentBranch='main'
            initialRevision='abc123def456'
          />
        </MantineProvider>
      ) as ReactElement
    );

    // Then: the field carries the prefilled hash and the action is enabled
    expect(screen.getByLabelText('Revision')).toHaveValue('abc123def456');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sync to Revision' }));
    expect(onSync).toHaveBeenCalledWith({
      revision: 'abc123def456',
      forwardChanges: false,
    });
  });

  it('should reset the form when cancelled', async () => {
    // Given: an open modal whose seeded revision has been replaced and whose
    // keep-local-changes checkbox has been toggled on
    const user = userEvent.setup();
    const onClose = jest.fn();
    const modal = (opened: boolean): ReactElement => (
      <MantineProvider>
        <RevisionSyncModal
          opened={opened}
          onClose={onClose}
          onSync={jest.fn()}
          currentBranch='main'
          initialRevision='abc123def456'
        />
      </MantineProvider>
    );
    const { rerender } = render(modal(true));
    await user.clear(screen.getByLabelText('Revision'));
    await user.type(screen.getByLabelText('Revision'), '@2');
    await user.click(screen.getByLabelText('Keep local changes'));
    expect(screen.getByLabelText('Keep local changes')).toBeChecked();

    // When: cancelling, then reopening the modal
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    rerender(modal(false));
    rerender(modal(true));

    // Then: the reopened form is reset — the checkbox was cleared by the
    // cancel handler and the revision field carries only the seed again
    expect(await screen.findByLabelText('Keep local changes')).not.toBeChecked();
    expect(screen.getByLabelText('Revision')).toHaveValue('abc123def456');
  });
});
