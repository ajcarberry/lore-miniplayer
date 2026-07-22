import type { ReactElement } from 'react';
import { useState } from 'react';
import { Alert, Button, Checkbox, Group, List, Modal, Stack, Text } from '@mantine/core';
import type { Workspace } from '../../../shared/types';

export interface TeardownConfirmModalProps {
  readonly opened: boolean;
  readonly workspace: Workspace | null;
  // Uncommitted or unpushed work is present — teardown refuses unless forced
  // (mirrors P3's guard). The force checkbox only appears in this case.
  readonly requiresForce: boolean;
  readonly isTearingDown: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (force: boolean) => void;
}

// Confirms the destructive workspace close (design 2a's ✕). States exactly what
// is removed: the worktree directory and the archived local branch; the remote
// branch is NOT removed (a server ask — P1d). When uncommitted/unpushed work
// exists, the force checkbox gates the confirm button.
export function TeardownConfirmModal({
  opened,
  workspace,
  requiresForce,
  isTearingDown,
  onClose,
  onConfirm,
}: TeardownConfirmModalProps): ReactElement {
  // The force acknowledgement resets per opening via the caller's `key` (it
  // remounts this component for each teardown target), so no reset effect.
  const [force, setForce] = useState(false);

  const confirmDisabled = isTearingDown || (requiresForce && !force);

  return (
    <Modal opened={opened} onClose={onClose} title='Close workspace' centered size='md'>
      <Stack gap='md'>
        <Text size='sm'>
          {workspace
            ? `Closing “${workspace.branchName}” will permanently remove:`
            : 'This will permanently remove:'}
        </Text>
        <List size='sm' spacing={4}>
          <List.Item>the worktree directory{workspace ? ` (${workspace.path})` : ''}</List.Item>
          <List.Item>the local branch (archived)</List.Item>
        </List>
        <Text size='xs' c='dimmed'>
          The remote branch is not removed — that is a server-side operation.
        </Text>

        {requiresForce && (
          <Alert color='red' variant='light' title='Uncommitted or unpushed work'>
            <Stack gap='xs'>
              <Text size='sm'>
                This workspace has changes that are not committed or not pushed. Closing it will
                discard them.
              </Text>
              <Checkbox
                checked={force}
                onChange={event => setForce(event.currentTarget.checked)}
                label='Force close and discard this work'
              />
            </Stack>
          </Alert>
        )}

        <Group justify='flex-end' gap='sm'>
          <Button variant='subtle' onClick={onClose} disabled={isTearingDown}>
            Cancel
          </Button>
          <Button
            color='red'
            onClick={() => onConfirm(force)}
            disabled={confirmDisabled}
            loading={isTearingDown}
          >
            Close workspace
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
