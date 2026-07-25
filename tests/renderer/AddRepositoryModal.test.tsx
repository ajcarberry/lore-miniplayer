import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddRepositoryModal } from '../../src/renderer/components/AddRepositoryModal';
import { installMockElectronAPI } from '../mocks/electron-api';
import { renderWithMantine } from './test-utils';

function renderModal(serverUrl = 'lore.example.com'): ReturnType<typeof renderWithMantine> {
  return renderWithMantine(
    <AddRepositoryModal serverUrl={serverUrl} opened onClose={jest.fn()} onAdd={jest.fn()} />
  );
}

describe('AddRepositoryModal', () => {
  let api: ReturnType<typeof installMockElectronAPI>;

  beforeEach(() => {
    api = installMockElectronAPI();
  });

  it('should load remote repositories from the connected server', async () => {
    // Given: the server lists repositories
    (api.lore.repository.listRemoteRepositories as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ name: 'RepoA', url: 'lore.example.com/RepoA' }],
    });

    // When: opening the modal
    renderModal();

    // Then: the listing is requested for the connected server
    await waitFor(() =>
      expect(api.lore.repository.listRemoteRepositories).toHaveBeenCalledWith('lore.example.com')
    );
  });

  it('should surface a listing failure as an error message', async () => {
    // Given: the server listing fails
    (api.lore.repository.listRemoteRepositories as jest.Mock).mockResolvedValue({
      success: false,
      error: 'connection refused',
    });

    // When: opening the modal
    renderModal();

    // Then: the failure is shown to the user, naming the server
    expect(await screen.findByText(/connection refused/)).toBeInTheDocument();
    expect(screen.getByText(/lore\.example\.com/)).toBeInTheDocument();
  });

  it('should not request repositories without a server address', async () => {
    // When: opening the modal with an empty server URL
    renderModal('');

    // Then: once the modal has rendered and its mount effects have flushed
    // (the fetch decision is synchronous in the mount effect), no listing
    // request was made
    expect(await screen.findByText('Define Workspace')).toBeInTheDocument();
    await act(async () => {});
    expect(api.lore.repository.listRemoteRepositories).not.toHaveBeenCalled();
  });

  it('should switch to existing mode when the selected directory is a working copy', async () => {
    // Given: directory selection returns a Lore working copy
    const user = userEvent.setup();
    (api.repository.selectDirectory as jest.Mock).mockResolvedValue({
      success: true,
      data: '/repos/existing-repo',
    });
    (api.lore.repository.checkStatus as jest.Mock).mockResolvedValue({
      success: true,
      data: { exists: true, isLoreRepo: true },
    });
    renderModal();

    // When: picking the directory
    await user.click(screen.getByRole('button', { name: 'Select base directory' }));

    // Then: existing mode is active with the name auto-filled from the folder
    expect(
      await screen.findByText('Selected directory contains a Lore repository')
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Workspace Name/)).toHaveValue('existing-repo');
    expect(
      await screen.findByRole('button', { name: 'Add Existing Workspace' })
    ).toBeInTheDocument();
  });

  it('should create and clone a new repository on submit', async () => {
    // Given: a server repo is selected and a target directory picked
    const user = userEvent.setup();
    (api.lore.repository.listRemoteRepositories as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ name: 'RepoA', url: 'lore.example.com/RepoA' }],
    });
    (api.repository.selectDirectory as jest.Mock).mockResolvedValue({
      success: true,
      data: '/repos',
    });
    (api.lore.repository.checkStatus as jest.Mock).mockResolvedValue({
      success: true,
      data: { exists: true, isLoreRepo: false },
    });
    (api.repository.create as jest.Mock).mockImplementation(async input => ({
      success: true,
      data: {
        ...(input as object),
        id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    }));
    renderModal();

    // And: the server listing has loaded
    await waitFor(() => expect(api.lore.repository.listRemoteRepositories).toHaveBeenCalled());

    // When: choosing the repository from the dropdown
    // (the dropdown portals outside the modal, which aria-hides it)
    await user.click(screen.getByPlaceholderText('Search repositories...'));
    await user.click(await screen.findByRole('option', { name: 'RepoA', hidden: true }));

    // And: picking the base directory
    await user.click(screen.getByRole('button', { name: 'Select base directory' }));
    await screen.findByDisplayValue('/repos');

    // And: submitting
    await user.click(screen.getByRole('button', { name: 'Add & Clone Workspace' }));

    // Then: the repository is created and cloned into <base>/<name>
    await waitFor(() =>
      expect(api.repository.create).toHaveBeenCalledWith({
        name: 'RepoA',
        url: 'lore.example.com/RepoA',
        localPath: '/repos/RepoA',
      })
    );
    await waitFor(() =>
      expect(api.lore.repository.clone).toHaveBeenCalledWith(
        'lore.example.com/RepoA',
        '/repos/RepoA'
      )
    );
  });

  it('should keep submission disabled while required fields are missing', () => {
    // Given: the modal with nothing filled in
    renderModal();

    // Then: the submit button is disabled and nothing can be created
    expect(screen.getByRole('button', { name: 'Add & Clone Workspace' })).toBeDisabled();
    expect(api.repository.create).not.toHaveBeenCalled();
  });
});
