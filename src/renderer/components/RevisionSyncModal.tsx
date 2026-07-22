import type { ReactElement } from 'react';
import { useState, useCallback } from 'react';
import { Modal, TextInput, Button, Group, Stack, Alert, Checkbox, Text } from '@mantine/core';
import { IconAlertCircle, IconGitCommit } from '@tabler/icons-react';
import type { LoreSyncOptions } from '../../shared/types';

interface RevisionSyncModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onSync: (options: LoreSyncOptions) => void;
  readonly currentBranch?: string;
  readonly isLoading?: boolean;
  // Prefills the revision field when the modal opens (e.g. from the history
  // section's "Sync to r<n>" action). Empty opens a blank field.
  readonly initialRevision?: string;
}

export function RevisionSyncModal({
  opened,
  onClose,
  onSync,
  currentBranch,
  isLoading = false,
  initialRevision = '',
}: RevisionSyncModalProps): ReactElement {
  const [revision, setRevision] = useState('');
  const [keepLocalChanges, setKeepLocalChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the revision field each time the modal opens, so a prefilled hash
  // from the history action lands in the input and a fresh open clears stale
  // typing. Adjusted during render on the open transition (the react.dev "You
  // Might Not Need an Effect" prev-tracking pattern) to avoid a
  // setState-in-effect. `prevOpened` starts false so a modal mounted already
  // open still seeds on its first render.
  const [prevOpened, setPrevOpened] = useState(false);
  if (opened !== prevOpened) {
    setPrevOpened(opened);
    if (opened) {
      setRevision(initialRevision);
      setError(null);
    }
  }

  const validateRevision = useCallback((value: string): string | null => {
    if (!value.trim()) {
      return 'Revision is required';
    }

    const trimmedValue = value.trim();

    // Check for shorthand revision number format (@1, @2, etc.)
    const shorthandPattern = /^@\d+$/;
    if (shorthandPattern.test(trimmedValue)) {
      return null; // Valid shorthand format
    }

    // Check for hex hash format (full or partial)
    if (trimmedValue.length < 6) {
      return 'Revision hash must be at least 6 characters (or use @N for revision number)';
    }

    const hexPattern = /^[a-fA-F0-9]+$/;
    if (!hexPattern.test(trimmedValue)) {
      return 'Revision must be a hex hash or revision number (e.g., @2)';
    }

    return null;
  }, []);

  const handleSync = useCallback((): void => {
    const validationError = validateRevision(revision);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);

    const options: LoreSyncOptions = {
      revision: revision.trim(),
      forwardChanges: keepLocalChanges,
    };

    onSync(options);
  }, [revision, keepLocalChanges, validateRevision, onSync]);

  const handleClose = useCallback((): void => {
    if (!isLoading) {
      setRevision('');
      setKeepLocalChanges(false);
      setError(null);
      onClose();
    }
  }, [isLoading, onClose]);

  const handleRevisionChange = useCallback(
    (value: string): void => {
      setRevision(value);
      if (error) {
        setError(null);
      }
    },
    [error]
  );

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title='Sync to Specific Revision'
      size='md'
      closeOnClickOutside={!isLoading}
      closeOnEscape={!isLoading}
    >
      <Stack gap='sm'>
        {currentBranch && (
          <Text size='sm' c='dimmed'>
            Current branch: <strong>{currentBranch}</strong>
          </Text>
        )}

        <TextInput
          label='Revision'
          placeholder='abc123def456 or @2'
          value={revision}
          onChange={event => handleRevisionChange(event.currentTarget.value)}
          disabled={isLoading}
          leftSection={<IconGitCommit size={16} />}
          description='Enter a revision hash or number'
          error={error}
        />

        <Checkbox
          label='Keep local changes'
          checked={keepLocalChanges}
          onChange={event => setKeepLocalChanges(event.currentTarget.checked)}
          disabled={isLoading}
        />

        <Alert icon={<IconAlertCircle size={16} />} variant='light' color='blue'>
          <Text size='xs'>
            This will sync your workspace to the specified revision. If &quot;Keep local
            changes&quot; is enabled, Lore will attempt to preserve your uncommitted changes.
          </Text>
        </Alert>

        <Group justify='flex-end' gap='sm'>
          <Button variant='subtle' onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSync} disabled={!revision.trim() || isLoading} loading={isLoading}>
            Sync to Revision
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
