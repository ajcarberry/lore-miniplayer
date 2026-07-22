import type { ReactElement } from 'react';
import { useState, useCallback } from 'react';
import {
  Modal,
  TextInput,
  Button,
  Group,
  Stack,
  Alert,
  ActionIcon,
  Progress,
  rgba,
  useMantineTheme,
} from '@mantine/core';
import { IconAlertCircle, IconFolderOpen } from '@tabler/icons-react';
import type { Repository } from '../../shared/types';
import type { RemoteRepository } from '../hooks/useRemoteRepositories';
import { useRemoteRepositories } from '../hooks/useRemoteRepositories';
import { useRepositorySubmission } from '../hooks/useRepositorySubmission';
import { sanitizeRepositoryName, validateRepositoryName } from '../utils/repository-name';
import { RemoteRepositoryPicker } from './RemoteRepositoryPicker';
import classes from './AddRepositoryModal.module.css';

interface AddRepositoryModalProps {
  readonly serverUrl: string;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onAdd: (repository: Repository) => void;
}

type RepositoryMode = 'new' | 'existing';

function buttonText(mode: RepositoryMode, cloneProgress: number, cloneComplete: boolean): string {
  if (cloneComplete) {
    return 'Workspace Added!';
  }
  if (cloneProgress > 0 && mode === 'new') {
    return `Cloning... ${Math.floor(cloneProgress)}%`;
  }
  return mode === 'existing' ? 'Add Existing Workspace' : 'Add & Clone Workspace';
}

function isFormComplete(
  mode: RepositoryMode,
  friendlyName: string,
  baseDirectory: string,
  selectedRepoUrl: string
): boolean {
  if (validateRepositoryName(friendlyName) !== null || !baseDirectory || !friendlyName) {
    return false;
  }
  return mode === 'existing' || selectedRepoUrl.length > 0;
}

export function AddRepositoryModal({
  serverUrl,
  opened,
  onClose,
  onAdd,
}: AddRepositoryModalProps): ReactElement {
  const theme = useMantineTheme();
  const {
    remoteRepos,
    isLoading: isLoadingRepos,
    loadError,
  } = useRemoteRepositories(serverUrl, opened);

  const [friendlyName, setFriendlyName] = useState('');
  const [selectedRepoUrl, setSelectedRepoUrl] = useState('');
  const [baseDirectory, setBaseDirectory] = useState('');
  const [mode, setMode] = useState<RepositoryMode>('new');

  const resetForm = useCallback((): void => {
    setFriendlyName('');
    setSelectedRepoUrl('');
    setBaseDirectory('');
    setMode('new');
  }, []);

  const submission = useRepositorySubmission({ onAdd, onClose, onDone: resetForm });
  const { isCloning, cloneProgress, cloneComplete, error, setError, submit } = submission;

  const handleRepoSelect = useCallback(
    (repo: RemoteRepository): void => {
      setSelectedRepoUrl(repo.url);
      // Auto-suggest name if not set
      if (!friendlyName) {
        void sanitizeRepositoryName(repo.name).then(setFriendlyName);
      }
    },
    [friendlyName]
  );

  const handleSelectDirectory = useCallback(async (): Promise<void> => {
    const dirResult = await window.electronAPI.repository.selectDirectory();
    if (!dirResult.success) {
      setError(dirResult.error);
      return;
    }
    const selectedPath = dirResult.data;
    if (!selectedPath) {
      return;
    }
    setBaseDirectory(selectedPath);

    // Check if this is an existing Lore repository
    const statusResult = await window.electronAPI.lore.repository.checkStatus(selectedPath);
    if (statusResult.success && statusResult.data.isLoreRepo) {
      setMode('existing');
      // Auto-populate name from directory using path.basename
      const basenameResult = await window.electronAPI.path.basename(selectedPath);
      setFriendlyName(basenameResult.success ? basenameResult.data : 'workspace');
      setSelectedRepoUrl('');
    } else {
      setMode('new');
    }
  }, [setError]);

  const handleClose = useCallback((): void => {
    if (!isCloning) {
      resetForm();
      setError(null);
      onClose();
    }
  }, [isCloning, resetForm, setError, onClose]);

  const handleSubmit = useCallback((): void => {
    void submit({ mode, friendlyName, selectedRepoUrl, baseDirectory });
  }, [submit, mode, friendlyName, selectedRepoUrl, baseDirectory]);

  const nameError = validateRepositoryName(friendlyName);
  const isFormValid = isFormComplete(mode, friendlyName, baseDirectory, selectedRepoUrl);
  const displayError = error ?? loadError;

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title='Define Workspace'
      fullScreen
      closeOnClickOutside={!isCloning}
      closeOnEscape={!isCloning}
    >
      <Stack>
        {/* Repository Selection - First, hidden for existing repos */}
        {mode === 'new' && (
          <RemoteRepositoryPicker
            key={opened ? 'open' : 'closed'}
            remoteRepos={remoteRepos}
            isLoading={isLoadingRepos}
            disabled={isCloning}
            onSelect={handleRepoSelect}
          />
        )}

        {/* Base Directory Selection - Second */}
        <TextInput
          label='Base Directory'
          placeholder='Select base directory...'
          value={baseDirectory}
          readOnly
          rightSection={
            <ActionIcon
              onClick={handleSelectDirectory}
              disabled={isCloning}
              size='sm'
              aria-label='Select base directory'
            >
              <IconFolderOpen size={16} />
            </ActionIcon>
          }
          description={
            mode === 'existing'
              ? 'Selected directory contains a Lore repository'
              : 'Select where to store the workspace'
          }
          required
          disabled={isCloning}
          size='sm'
        />

        {/* Repository Name Input - Last */}
        <TextInput
          label='Workspace Name'
          placeholder='my-project'
          value={friendlyName}
          onChange={e => setFriendlyName(e.currentTarget.value)}
          error={friendlyName ? nameError : null}
          description={
            mode === 'existing'
              ? 'Name for this workspace in the app'
              : 'This will be the folder name on your computer'
          }
          required
          disabled={isCloning || mode === 'existing'}
          size='sm'
        />

        {displayError && (
          <Alert icon={<IconAlertCircle size={16} />} color='red' variant='light'>
            {displayError}
          </Alert>
        )}

        <Group justify='flex-end' mt='md'>
          {/* Submit Button with Progress - No Cancel button */}
          <Button
            className={classes.button}
            onClick={handleSubmit}
            disabled={!isFormValid || isCloning}
            color={cloneComplete ? 'teal' : theme.primaryColor}
            radius='md'
          >
            <div className={classes.label}>{buttonText(mode, cloneProgress, cloneComplete)}</div>
            {cloneProgress > 0 && !cloneComplete && (
              <Progress
                value={cloneProgress}
                className={classes.progress}
                color={rgba(theme.colors.blue[2], 0.35)}
                radius='sm'
              />
            )}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
