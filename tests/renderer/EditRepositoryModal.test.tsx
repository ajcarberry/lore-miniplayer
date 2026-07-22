jest.mock('../../src/renderer/utils/logging', () => ({
  logError: jest.fn(),
}));
jest.mock('../../src/renderer/utils/notify', () => ({
  notifyError: jest.fn(),
  notifySuccess: jest.fn(),
}));

import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditRepositoryModal } from '../../src/renderer/components/EditRepositoryModal';
import { logError } from '../../src/renderer/utils/logging';
import { notifyError } from '../../src/renderer/utils/notify';
import { installMockElectronAPI } from '../mocks/electron-api';
import { makeRepository } from '../mocks/repository-fixture';

const repository = makeRepository();

function renderModal(
  overrides: Partial<Parameters<typeof EditRepositoryModal>[0]> = {}
): ReturnType<typeof render> & { onSave: jest.Mock; onDelete: jest.Mock; onClose: jest.Mock } {
  const onSave = jest.fn();
  const onDelete = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    (
      <MantineProvider>
        <EditRepositoryModal
          opened
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
          repository={repository}
          {...overrides}
        />
      </MantineProvider>
    ) as ReactElement
  );
  return { ...utils, onSave, onDelete, onClose };
}

describe('EditRepositoryModal', () => {
  let api: ReturnType<typeof installMockElectronAPI>;

  beforeEach(() => {
    jest.clearAllMocks();
    api = installMockElectronAPI();
  });

  it('should prefill the repository name and disable Save until it changes', () => {
    // When: opening the modal
    renderModal();

    // Then: the name is prefilled and Save is disabled
    expect(screen.getByLabelText(/Workspace Name/)).toHaveValue('MyRepo');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('should style the read-only inputs with theme tokens, not light-mode grays', () => {
    // Given: the edit view
    renderModal();

    // Then: the URL and Local Path inputs use the parchment token system,
    // which adapts to dark mode — never hardcoded Mantine gray shades
    for (const value of [repository.url, repository.localPath]) {
      const input = screen.getByDisplayValue(value);
      expect(input.getAttribute('style')).not.toContain('--mantine-color-gray');
      expect(input.getAttribute('style')).toContain('--paper-sink');
      expect(input.getAttribute('style')).toContain('--ink-faint');
    }
  });

  it('should save the renamed repository', async () => {
    // Given: the edit view
    const user = userEvent.setup();
    const { onSave, onClose } = renderModal();

    // When: renaming and saving
    const nameInput = screen.getByLabelText(/Workspace Name/);
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    // Then: onSave receives the updated repository and the modal closes
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: repository.id, name: 'Renamed' })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('should update the accent hue when a different swatch is selected and saved', async () => {
    // Given: the edit view
    const user = userEvent.setup();
    const { onSave, onClose } = renderModal();

    // When: choosing a different accent swatch and saving (no name change)
    await user.click(screen.getByRole('button', { name: /Verdigris accent/i }));
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    // Then: onSave receives the updated accent hue and the modal closes
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: repository.id, accentHue: 172 })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('should require delete confirmation before calling onDelete', async () => {
    // Given: the edit view
    const user = userEvent.setup();
    const { onDelete } = renderModal();

    // When: clicking Delete Repository
    await user.click(screen.getByRole('button', { name: /Delete Workspace/ }));

    // Then: a confirmation view appears without deleting yet
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/will not be deleted/)).toBeInTheDocument();

    // When: confirming
    await user.click(screen.getByRole('button', { name: /Remove from Lore/ }));

    // Then: the repository is deleted
    expect(onDelete).toHaveBeenCalledWith(repository);
  });

  it('should return to the edit view when the delete is cancelled', async () => {
    // Given: the confirmation view
    const user = userEvent.setup();
    const { onDelete } = renderModal();
    await user.click(screen.getByRole('button', { name: /Delete Workspace/ }));

    // When: cancelling
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Then: back on the edit form, nothing deleted
    expect(screen.getByLabelText(/Workspace Name/)).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('should open the local path in the file explorer', async () => {
    // Given: the edit view
    const user = userEvent.setup();
    renderModal();

    // When: clicking Open in Finder
    await user.click(screen.getByRole('button', { name: 'Open in Finder' }));

    // Then: the explorer opens at the repository's local path
    await waitFor(() =>
      expect(api.repository.openInExplorer).toHaveBeenCalledWith(repository.localPath)
    );
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('should log and notify when opening the file explorer fails', async () => {
    // Given: the explorer IPC call returns a failure result
    const user = userEvent.setup();
    renderModal();
    (api.repository.openInExplorer as jest.Mock).mockResolvedValue({
      success: false,
      error: 'no explorer',
    });

    // When: clicking Open in Finder
    await user.click(screen.getByRole('button', { name: 'Open in Finder' }));

    // Then: the failure is logged and surfaced to the user
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith('Open in Explorer Failed', 'no explorer')
    );
    expect(logError).toHaveBeenCalledWith(
      'Failed to open in explorer',
      expect.objectContaining({
        localPath: repository.localPath,
        operation: 'EditRepositoryModal',
      })
    );
  });

  it('should copy the local path to the clipboard', async () => {
    // Given: the edit view
    const user = userEvent.setup();
    renderModal();
    const writeText = jest.spyOn(navigator.clipboard, 'writeText');

    // When: clicking Copy Path
    await user.click(screen.getByRole('button', { name: 'Copy Path' }));

    // Then: the local path is written to the clipboard
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(repository.localPath));
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('should log and notify when copying the path fails', async () => {
    // Given: clipboard access is denied
    const user = userEvent.setup();
    renderModal();
    jest.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    // When: clicking Copy Path
    await user.click(screen.getByRole('button', { name: 'Copy Path' }));

    // Then: the failure is logged and surfaced to the user
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith('Copy Path Failed', expect.any(Error))
    );
    expect(logError).toHaveBeenCalledWith(
      'Failed to copy path',
      expect.objectContaining({
        localPath: repository.localPath,
        operation: 'EditRepositoryModal',
      })
    );
  });

  it('should render nothing without a repository', () => {
    // When: opening with no repository
    renderModal({ repository: null });

    // Then: the modal content is absent
    expect(screen.queryByText('Edit Workspace')).not.toBeInTheDocument();
  });
});
