import type { ReactElement } from 'react';
import { ActionIcon, Badge, Group, Text } from '@mantine/core';
import { IconEyeOff, IconX } from '@tabler/icons-react';
import type { Workspace } from '../../../shared/types';

// Shared identity/removal chrome for the Mission Control card header and the
// idle-band row, so the two surfaces cannot drift (design 2a + packet U3).

// Mission Control is PRIMARILY keyed by workspace name — the registry `name`,
// not the current branch — so the title is the name; hover reveals the
// worktree directory. The branch is a secondary identifier, rendered
// unconditionally even when it reads the same as the name (e.g. a provisioned
// worktree), for consistency. The active anchor carries a badge.
export function WorkspaceIdentity({
  workspace,
  isActive,
}: {
  readonly workspace: Workspace;
  readonly isActive: boolean;
}): ReactElement {
  return (
    <>
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
    </>
  );
}

// The Forget (untrack-only) and ✕ Close (destructive teardown) pair, both
// disabled for the active workspace. Right-aligned via ml='auto' — a no-op in
// rows that already carry their own flex spacer.
export function WorkspaceRemovalActions({
  workspace,
  isActive,
  onForget,
  onTeardown,
}: {
  readonly workspace: Workspace;
  readonly isActive: boolean;
  readonly onForget: () => void;
  readonly onTeardown: () => void;
}): ReactElement {
  // The active workspace's ✕/Forget are disabled with this explanation.
  const activeTitle = isActive
    ? 'This is the workspace you are currently in — close or forget another one instead'
    : undefined;

  return (
    <Group gap={8} wrap='nowrap' ml='auto'>
      <ActionIcon
        size='sm'
        variant='subtle'
        color='gray'
        aria-label={`Forget workspace ${workspace.branchName}`}
        title={activeTitle ?? 'Forget (stop tracking, keep the files)'}
        disabled={isActive}
        onClick={onForget}
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
        onClick={onTeardown}
      >
        <IconX size={14} />
      </ActionIcon>
    </Group>
  );
}
