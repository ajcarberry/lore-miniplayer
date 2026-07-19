import type { KeyboardEvent, ReactElement } from 'react';
import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';

export interface CommitDialogProps {
  readonly opened: boolean;
  readonly branchName: string;
  readonly stagedCount: number;
  readonly message: string;
  readonly onMessageChange: (message: string) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly isCommitting: boolean;
}

// In-card overlay for writing a commit message and committing the staged
// working set. Escape (Modal's default) cancels; Cmd/Ctrl+Enter submits when
// the message is non-empty.
export function CommitDialog({
  opened,
  branchName,
  stagedCount,
  message,
  onMessageChange,
  onCancel,
  onSubmit,
  isCommitting,
}: CommitDialogProps): ReactElement {
  const canSubmit = message.trim().length > 0 && !isCommitting;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (canSubmit) {
        onSubmit();
      }
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onCancel}
      title={`Commit to ${branchName}`}
      centered
      withinPortal
      size='sm'
    >
      <Stack gap='md'>
        <Textarea
          data-autofocus
          placeholder={`${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`}
          value={message}
          onChange={event => onMessageChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          minRows={3}
          maxRows={6}
          autosize
          disabled={isCommitting}
        />
        <Group justify='space-between' align='center'>
          <Text size='xs' c='dimmed'>
            ⌘⏎ to commit
          </Text>
          <Group gap='sm'>
            <Button variant='subtle' onClick={onCancel} disabled={isCommitting}>
              Cancel
            </Button>
            <Button onClick={onSubmit} disabled={!canSubmit} loading={isCommitting}>
              Commit
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
