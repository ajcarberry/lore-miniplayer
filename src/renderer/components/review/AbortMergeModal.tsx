import type { ReactElement } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';

export interface AbortMergeModalProps {
  readonly opened: boolean;
  readonly sourceBranch: string;
  readonly aborting: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

// Confirms the destructive abort of an in-flight merge: aborting
// restores the source branch to its pre-merge state and discards every
// conflict resolution, so it is gated behind an explicit confirm.
export function AbortMergeModal(props: AbortMergeModalProps): ReactElement {
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title='Discard this merge?'
      centered
      size='md'
    >
      <Stack gap='md'>
        <Text size='sm'>
          Aborting restores {props.sourceBranch} to its pre-merge state and discards every conflict
          resolution. This cannot be undone.
        </Text>
        <Group justify='flex-end' gap='sm'>
          <Button variant='default' onClick={props.onClose}>
            Keep merging
          </Button>
          <Button color='red' loading={props.aborting} onClick={props.onConfirm}>
            Discard merge
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
