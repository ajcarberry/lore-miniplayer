import type { ReactElement } from 'react';
import { Button, Group, Text, TextInput } from '@mantine/core';

export interface CommitBarProps {
  readonly stagedCount: number;
  readonly totalCount: number;
  readonly message: string;
  readonly onMessageChange: (message: string) => void;
  readonly onCommit: () => void;
  readonly committing: boolean;
  // Once a commit lands, the bar swaps its one contextual action to Push
  // (commit and push stay separate — the app never pushes on commit).
  readonly committed: boolean;
  readonly onPush: () => void;
  readonly pushing: boolean;
}

// The review window's bottom bar in the commit workflow (design 2b): staged
// count, message input, and the single contextual primary action. Commit is
// gated on a non-empty message and at least one staged file; after it lands the
// action becomes Push.
export function CommitBar(props: CommitBarProps): ReactElement {
  const { stagedCount, totalCount, message, committing, committed, pushing } = props;
  const canCommit = message.trim().length > 0 && stagedCount > 0 && !committing;

  return (
    <Group
      gap='sm'
      px='md'
      py='sm'
      wrap='nowrap'
      style={{
        borderTop: '1px solid var(--hairline, rgba(43,36,22,.1))',
        background: 'var(--paper-raised, #fbf7ec)',
      }}
    >
      <Text size='xs' ff='var(--font-mono)' c='dimmed' style={{ whiteSpace: 'nowrap' }}>
        {committed ? 'Committed — push to share' : `${stagedCount} of ${totalCount} staged`}
      </Text>
      <TextInput
        style={{ flex: 1 }}
        size='sm'
        placeholder='Commit message'
        aria-label='Commit message'
        value={message}
        disabled={committed}
        onChange={event => props.onMessageChange(event.currentTarget.value)}
      />
      {committed ? (
        <Button size='sm' variant='light' loading={pushing} onClick={props.onPush}>
          Push
        </Button>
      ) : (
        <Button size='sm' loading={committing} disabled={!canCommit} onClick={props.onCommit}>
          Commit
        </Button>
      )}
    </Group>
  );
}
