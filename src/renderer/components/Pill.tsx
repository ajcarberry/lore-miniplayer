import type { MouseEvent, PointerEvent, ReactElement } from 'react';
import { ActionIcon, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconGitCommit, IconRefresh, IconUpload, IconX } from '@tabler/icons-react';
import type { Repository } from '../../shared/types';
import type { ActionSignals } from '../utils/actionSignals';
import { LoreLogo } from './LoreLogo';
import { RepoEyebrow } from './RepoEyebrow';

interface PillProps {
  readonly repository: Repository | null;
  readonly branchName: string;
  readonly signals: ActionSignals;
  readonly onClose: () => void;
}

// One accent-lit glyph for an active signal, using the same icon the
// transport row's matching button carries.
function SignalGlyph({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <Tooltip label={label}>
      <span aria-label={label} style={{ display: 'inline-flex', color: 'var(--acc)' }}>
        {children}
      </span>
    </Tooltip>
  );
}

// The quiet-pill signal cluster: glyphs render only while actionable, so a
// pill with no glyphs means all clear. Mirrors the transport row's accents
// (sync / commit / push) — same icons, same repo-accent color.
function PillSignals({ signals }: { readonly signals: ActionSignals }): ReactElement | null {
  const { syncNeeded, uncommitted, unpushed } = signals;
  if (!syncNeeded && !uncommitted && !unpushed) {
    return null;
  }
  return (
    <Group gap={6} wrap='nowrap' align='center'>
      {syncNeeded && (
        <SignalGlyph label='Sync needed'>
          <IconRefresh size={14} />
        </SignalGlyph>
      )}
      {uncommitted && (
        <SignalGlyph label='Uncommitted changes'>
          <IconGitCommit size={14} />
        </SignalGlyph>
      )}
      {unpushed && (
        <SignalGlyph label='Commits to push'>
          <IconUpload size={14} />
        </SignalGlyph>
      )}
    </Group>
  );
}

// The collapsed, ambient rendering of the player: a draggable capsule with the
// logomark, repo-name eyebrow over the current branch (eyebrow omitted when no
// repository is selected, its tooltip carrying the local checkout path),
// and the action-signal glyphs, right-aligned at the
// window's bottom edge (morph.css). It is deliberately NOT a native
// `-webkit-app-region: drag` region — that would route real mouse events to the
// OS and defeat click-to-expand; dragging is handled manually in useExpansion.
// The close control stops pointer/click propagation so it never starts a drag
// or toggles the card.
export function Pill({ repository, branchName, signals, onClose }: PillProps): ReactElement {
  const stopPointer = (event: PointerEvent): void => event.stopPropagation();
  const handleClose = (event: MouseEvent): void => {
    event.stopPropagation();
    onClose();
  };

  return (
    <Paper
      className='morph-pill-bar'
      radius='xl'
      shadow='md'
      px='lg'
      style={{
        border: '1px solid var(--hair)',
        background: 'var(--paper-raised)',
        minHeight: 64,
        width: 'fit-content',
        maxWidth: 320,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <Group gap={12} wrap='nowrap' align='center'>
        <LoreLogo variant='mark' height='28px' />
        <Stack gap={0}>
          <RepoEyebrow repository={repository} />
          <Text ff='var(--font-mono)' fw={600} size='md' truncate style={{ maxWidth: 180 }}>
            {branchName || 'main'}
          </Text>
        </Stack>
        <PillSignals signals={signals} />
        <ActionIcon
          size='sm'
          variant='subtle'
          radius='sm'
          color='red'
          aria-label='Close'
          onClick={handleClose}
          onPointerDown={stopPointer}
          onPointerUp={stopPointer}
        >
          <IconX size={14} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}
