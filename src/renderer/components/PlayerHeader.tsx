import type { ReactElement } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import type { Repository } from '../../shared/types';
import { AttentionChip } from './AttentionChip';
import { LoreLogo } from './LoreLogo';
import { RepoEyebrow } from './RepoEyebrow';

export interface PlayerHeaderProps {
  readonly repository: Repository | null;
  readonly branchName: string;
  readonly onOpenSwitcher: () => void;
  // Aggregate agent-attention counts (design 1c) and the Mission Control
  // launcher for the header's entry chip — 0/0 renders no chip at all.
  readonly needsYouCount: number;
  readonly activeCount: number;
  readonly onOpenMissionControl: () => void;
}

// Always-visible card header: logomark + repo-name eyebrow over the branch
// name (falling back to a static "On branch" label when no repository is
// selected), and the agent-attention chip (design 1c drops the chevron in
// its favor — the chip mirrors the pill's states and opens Mission
// Control). Action state (sync/commit/push) is carried by the transport
// buttons' accents, not a header badge. The whole header opens the
// branch-switcher popover; it's a clickable Box rather than a `<button>`
// because it now contains the chip's own button (nested `<button>`s are
// invalid HTML), matching WorkingSet's clickable-row pattern. The chip
// stops propagation so it opens Mission Control instead.
export function PlayerHeader({
  repository,
  branchName,
  onOpenSwitcher,
  needsYouCount,
  activeCount,
  onOpenMissionControl,
}: PlayerHeaderProps): ReactElement {
  return (
    <Box
      onClick={onOpenSwitcher}
      onKeyDown={event => {
        // role='button' on a div gets no native Enter/Space activation —
        // wire it up explicitly (preventDefault keeps Space from scrolling).
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenSwitcher();
        }
      }}
      role='button'
      tabIndex={0}
      aria-label='Switch branch'
      style={{ width: '100%', cursor: 'pointer' }}
    >
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
        <AttentionChip
          needsYouCount={needsYouCount}
          activeCount={activeCount}
          onOpen={onOpenMissionControl}
        />
      </Group>
    </Box>
  );
}
