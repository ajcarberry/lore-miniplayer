import type { ReactElement } from 'react';
import { ActionIcon, Badge, Box, Button, Group, Text } from '@mantine/core';
import { IconEyeOff, IconX } from '@tabler/icons-react';
import type { Workspace } from '../../../shared/types';

export interface IdleWorkspaceRowProps {
  readonly workspace: Workspace;
  // Whether this is the anchor workspace — the one the pill/card currently
  // displays. Its ✕ and Forget are disabled (same rule as the full card).
  readonly isActive: boolean;
  readonly onOpenTerminal: (path: string) => void;
  readonly onTeardown: (workspace: Workspace) => void;
  readonly onMarkActive: (workspace: Workspace) => void;
  // Untrack-only removal (design amendment) — the non-destructive
  // counterpart to onTeardown.
  readonly onForget: (workspace: Workspace) => void;
}

// A minimized idle-band row (design 2a): workspace name (Mission Control's
// primary identifier — hover reveals the worktree directory) with the branch
// as a muted secondary, Mark active (the manual idle → awaiting-review
// transition), Open terminal, Forget, and ✕ close. New workspaces land here
// until an agent session starts or the user marks them active.
export function IdleWorkspaceRow({
  workspace,
  isActive,
  onOpenTerminal,
  onTeardown,
  onMarkActive,
  onForget,
}: IdleWorkspaceRowProps): ReactElement {
  const activeTitle = isActive
    ? 'This is the workspace you are currently in — close or forget another one instead'
    : undefined;

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
        {workspace.name}
      </Text>
      <Text component='span' ff='var(--font-mono)' size='sm' c='dimmed'>
        {`on ${workspace.branchName}`}
      </Text>
      {isActive && (
        <Badge color='blue' variant='light' size='sm'>
          active
        </Badge>
      )}
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
        aria-label={`Forget workspace ${workspace.branchName}`}
        title={activeTitle ?? 'Forget (stop tracking, keep the files)'}
        disabled={isActive}
        onClick={() => onForget(workspace)}
      >
        <IconEyeOff size={14} />
      </ActionIcon>
      <ActionIcon
        size='sm'
        variant='subtle'
        color='gray'
        aria-label={`Close workspace ${workspace.branchName}`}
        title={activeTitle ?? 'Close workspace (removes the directory and archives the branch)'}
        disabled={isActive}
        onClick={() => onTeardown(workspace)}
      >
        <IconX size={14} />
      </ActionIcon>
    </Group>
  );
}
