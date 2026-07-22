import type { ReactElement } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';

interface ResetConfirmModalProps {
  readonly opened: boolean;
  readonly isResetting: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

export function ResetConfirmModal({
  opened,
  isResetting,
  onClose,
  onConfirm,
}: ResetConfirmModalProps): ReactElement {
  return (
    <Modal opened={opened} onClose={onClose} title='Confirm Reset' size='sm'>
      <Stack gap='md'>
        <Text>
          This will discard all local changes and reset to the remote state. This action cannot be
          undone.
        </Text>
        <Group justify='flex-end' gap='sm'>
          <Button variant='subtle' onClick={onClose} disabled={isResetting}>
            Cancel
          </Button>
          <Button color='red' onClick={onConfirm} loading={isResetting} disabled={isResetting}>
            Reset Workspace
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
