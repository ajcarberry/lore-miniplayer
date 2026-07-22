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
  Text,
  Box,
  ColorSwatch,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconFolderOpen,
  IconCopy,
  IconTrash,
  IconCheck,
} from '@tabler/icons-react';
import type { Repository } from '../../shared/types';
import { LORE_ACCENT_HUES, loreAccent } from '../../shared/accent';
import { logError } from '../utils/logging';
import { notifyError } from '../utils/notify';

const ACCENT_OPTIONS: ReadonlyArray<{ readonly label: string; readonly hue: number }> = [
  { label: 'Amber', hue: LORE_ACCENT_HUES.amber },
  { label: 'Verdigris', hue: LORE_ACCENT_HUES.verdigris },
  { label: 'Arcane', hue: LORE_ACCENT_HUES.arcane },
  { label: 'Ember', hue: LORE_ACCENT_HUES.ember },
];

interface AccentSwatchPickerProps {
  readonly selectedHue: number;
  readonly onSelect: (hue: number) => void;
}

function AccentSwatchPicker({ selectedHue, onSelect }: AccentSwatchPickerProps): ReactElement {
  return (
    <Box>
      <Text size='sm' fw={500} mb={5}>
        Accent Color
      </Text>
      <Group gap='xs'>
        {ACCENT_OPTIONS.map(option => {
          const isSelected = selectedHue === option.hue;
          return (
            <UnstyledButton
              key={option.hue}
              aria-label={`${option.label} accent`}
              aria-pressed={isSelected}
              onClick={() => onSelect(option.hue)}
            >
              <ColorSwatch
                color={loreAccent(option.hue).base}
                size={28}
                style={
                  isSelected
                    ? { outline: '2px solid var(--mantine-color-blue-6)', outlineOffset: 2 }
                    : undefined
                }
              >
                {isSelected && <IconCheck size={14} color='white' />}
              </ColorSwatch>
            </UnstyledButton>
          );
        })}
      </Group>
    </Box>
  );
}

interface EditRepositoryModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onSave: (repository: Repository) => void;
  readonly onDelete: (repository: Repository) => void;
  readonly repository: Repository | null;
}

type PanelView = 'edit' | 'confirmDelete';

interface DeleteConfirmationProps {
  readonly repositoryName: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function DeleteConfirmation({
  repositoryName,
  onCancel,
  onConfirm,
}: DeleteConfirmationProps): ReactElement {
  return (
    <Stack gap='lg' style={{ height: '100%', justifyContent: 'space-between' }}>
      <Alert
        icon={<IconAlertTriangle size={16} />}
        title='Delete Workspace'
        color='red'
        variant='light'
      >
        <Text size='sm'>
          This will remove <strong>&quot;{repositoryName}&quot;</strong> from Lore MiniPlayer. The
          files on disk will not be deleted.
        </Text>
      </Alert>

      <Group justify='space-between' mt='xl'>
        <Button variant='light' onClick={onCancel}>
          Cancel
        </Button>

        <Button color='red' onClick={onConfirm} leftSection={<IconTrash size={16} />}>
          Remove from Lore
        </Button>
      </Group>
    </Stack>
  );
}

export function EditRepositoryModal({
  opened,
  onClose,
  onSave,
  onDelete,
  repository,
}: EditRepositoryModalProps): ReactElement {
  const [repositoryName, setRepositoryName] = useState('');
  const [selectedAccentHue, setSelectedAccentHue] = useState<number>(LORE_ACCENT_HUES.amber);
  const [panelView, setPanelView] = useState<PanelView>('edit');

  // Reset state when the modal opens or the repository changes (state
  // adjustment during render instead of an effect)
  const openKey = opened && repository ? repository.id : null;
  const [prevOpenKey, setPrevOpenKey] = useState<string | null>(null);
  if (openKey !== prevOpenKey) {
    setPrevOpenKey(openKey);
    if (openKey !== null && repository) {
      setRepositoryName(repository.name);
      setSelectedAccentHue(repository.accentHue);
      setPanelView('edit');
    }
  }

  const handleClose = useCallback((): void => {
    setPanelView('edit');
    onClose();
  }, [onClose]);

  const handleSave = useCallback((): void => {
    if (!repository || !repositoryName.trim()) {
      return;
    }

    const updatedRepository: Repository = {
      ...repository,
      name: repositoryName.trim(),
      accentHue: selectedAccentHue,
      updatedAt: new Date().toISOString(),
    };
    onSave(updatedRepository);
    onClose();
  }, [repository, repositoryName, selectedAccentHue, onSave, onClose]);

  const handleDelete = useCallback((): void => {
    if (!repository) {
      return;
    }

    onDelete(repository);
    onClose();
  }, [repository, onDelete, onClose]);

  const handleOpenInFinder = useCallback(async (): Promise<void> => {
    if (!repository) {
      return;
    }

    const result = await window.electronAPI.repository.openInExplorer(repository.localPath);
    if (!result.success) {
      logError('Failed to open in explorer', {
        error: result.error,
        localPath: repository.localPath,
        operation: 'EditRepositoryModal',
      });
      notifyError('Open in Explorer Failed', result.error);
    }
  }, [repository]);

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!repository) {
      return;
    }

    try {
      await navigator.clipboard.writeText(repository.localPath);
    } catch (error) {
      logError('Failed to copy path', {
        error,
        localPath: repository.localPath,
        operation: 'EditRepositoryModal',
      });
      notifyError('Copy Path Failed', error);
    }
  }, [repository]);

  if (!repository) {
    return <></>;
  }

  const isNameChanged = repositoryName.trim() !== repository.name;
  const isAccentChanged = selectedAccentHue !== repository.accentHue;
  const isDirty = isNameChanged || isAccentChanged;
  const isFormValid = repositoryName.trim().length > 0;

  return (
    <Modal opened={opened} onClose={handleClose} title='Edit Workspace' fullScreen>
      {panelView === 'edit' ? (
        <Stack gap='lg' style={{ height: '100%', justifyContent: 'space-between' }}>
          <Stack gap='md'>
            {/* Repository Name - Editable */}
            <TextInput
              label='Workspace Name'
              placeholder='Enter workspace name'
              value={repositoryName}
              onChange={e => setRepositoryName(e.currentTarget.value)}
              required
              size='sm'
            />

            {/* Repository URL - Read-only */}
            <Box>
              <Text size='sm' fw={500} mb={5}>
                Repository URL
              </Text>
              <TextInput
                value={repository.url}
                readOnly
                size='sm'
                styles={{
                  input: {
                    backgroundColor: 'var(--paper-sink)',
                    color: 'var(--ink-faint)',
                    cursor: 'default',
                  },
                }}
              />
            </Box>

            {/* Local Path - Read-only with action buttons */}
            <Box>
              <Text size='sm' fw={500} mb={5}>
                Local Path
              </Text>
              <Group gap='xs'>
                <TextInput
                  value={repository.localPath}
                  readOnly
                  size='sm'
                  style={{ flex: 1 }}
                  styles={{
                    input: {
                      backgroundColor: 'var(--paper-sink)',
                      color: 'var(--ink-faint)',
                      cursor: 'default',
                    },
                  }}
                />
                <ActionIcon
                  size='md'
                  variant='light'
                  onClick={handleOpenInFinder}
                  title='Open in Finder'
                >
                  <IconFolderOpen size={16} />
                </ActionIcon>
                <ActionIcon size='md' variant='light' onClick={handleCopyPath} title='Copy Path'>
                  <IconCopy size={16} />
                </ActionIcon>
              </Group>
            </Box>

            {/* Accent Color */}
            <AccentSwatchPicker selectedHue={selectedAccentHue} onSelect={setSelectedAccentHue} />
          </Stack>

          {/* Bottom Actions */}
          <Group justify='space-between' mt='xl'>
            <Button
              color='red'
              variant='light'
              leftSection={<IconTrash size={16} />}
              onClick={() => setPanelView('confirmDelete')}
            >
              Delete Workspace
            </Button>

            <Button onClick={handleSave} disabled={!isFormValid || !isDirty}>
              Save Changes
            </Button>
          </Group>
        </Stack>
      ) : (
        <DeleteConfirmation
          repositoryName={repository.name}
          onCancel={() => setPanelView('edit')}
          onConfirm={handleDelete}
        />
      )}
    </Modal>
  );
}
