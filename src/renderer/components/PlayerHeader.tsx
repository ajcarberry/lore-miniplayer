import type { ReactElement } from 'react';
import { Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { Repository } from '../../shared/types';
import { LoreLogo } from './LoreLogo';
import { RepoEyebrow } from './RepoEyebrow';

interface PlayerHeaderProps {
  readonly repository: Repository | null;
  readonly branchName: string;
  readonly onOpenSwitcher: () => void;
}

// Always-visible card header: logomark + repo-name eyebrow over the branch
// name (falling back to a static "On branch" label when no repository is
// selected). The eyebrow's tooltip carries the local checkout path so two
// clones of the same repo stay distinguishable. Action state (sync/commit/
// push) is carried by the transport buttons' accents, not a header badge.
// The whole header is a button that opens the branch-switcher popover.
export function PlayerHeader({
  repository,
  branchName,
  onOpenSwitcher,
}: PlayerHeaderProps): ReactElement {
  return (
    <UnstyledButton onClick={onOpenSwitcher} aria-label='Switch branch' style={{ width: '100%' }}>
      <Group justify='space-between' wrap='nowrap'>
        <Group gap={8} wrap='nowrap'>
          <LoreLogo variant='mark' height='20px' />
          <Stack gap={0}>
            <RepoEyebrow repository={repository} fallbackLabel='On branch' />
            <Text ff='var(--font-mono)' fw={600} size='sm'>
              {branchName || (repository ? 'main' : '—')}
            </Text>
          </Stack>
        </Group>
        <IconChevronDown size={14} />
      </Group>
    </UnstyledButton>
  );
}
