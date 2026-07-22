import type { ReactElement } from 'react';
import { ActionIcon, Box, Button, Group, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import type { Workspace } from '../../../shared/types';

export interface IdleWorkspaceRowProps {
  readonly workspace: Workspace;
  readonly onOpenTerminal: (path: string) => void;
  readonly onTeardown: (workspace: Workspace) => void;
  readonly onMarkActive: (workspace: Workspace) => void;
}

// A minimized idle-band row (design 2a): branch (hover reveals the worktree
// directory), Mark active (the manual idle → awaiting-review transition), Open
// terminal, and ✕ close. New workspaces land here until an agent session
// starts or the user marks them active.
export function IdleWorkspaceRow({
  workspace,
  onOpenTerminal,
  onTeardown,
  onMarkActive,
}: IdleWorkspaceRowProps): ReactElement {
  return (
    <Group
      gap={9}
      wrap='nowrap'
      px={12}
      py={7}
      data-testid='idle-workspace-row'
      style={{ border: '1px solid var(--hair)', borderRadius: 8, opacity: 0.85 }}
    >
      <Box
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          border: '1.5px solid var(--ink-faint)',
        }}
      />
      <Text
        component='span'
        ff='var(--font-mono)'
        fw={600}
        size='sm'
        title={workspace.path}
        style={{ borderBottom: '1px dashed var(--hair)', cursor: 'help' }}
      >
        {workspace.branchName}
      </Text>
      <Box style={{ flex: 1 }} />
      <Button variant='subtle' size='compact-xs' onClick={() => onMarkActive(workspace)}>
        Mark active
      </Button>
      <Button variant='default' size='compact-xs' onClick={() => onOpenTerminal(workspace.path)}>
        Open terminal
      </Button>
      <ActionIcon
        size='sm'
        variant='subtle'
        color='gray'
        aria-label={`Close workspace ${workspace.branchName}`}
        onClick={() => onTeardown(workspace)}
      >
        <IconX size={14} />
      </ActionIcon>
    </Group>
  );
}
