import type { ReactElement } from 'react';
import { ActionIcon, Group, Text } from '@mantine/core';
import { IconChevronDown, IconMinus, IconX } from '@tabler/icons-react';
import { LoreLogo } from './LoreLogo';

interface TitleBarProps {
  // When provided, a collapse-to-pill control is shown (connected view only).
  readonly onCollapse?: () => void;
  // Appended as "Lore MiniPlayer — <titleSuffix>" (e.g. secondary windows like
  // Mission Control). Omitted: unchanged plain "Lore MiniPlayer" (main window).
  readonly titleSuffix?: string;
}

export function TitleBar({ onCollapse, titleSuffix }: TitleBarProps): ReactElement {
  return (
    <Group
      justify='space-between'
      px='sm'
      py={6}
      style={{
        WebkitAppRegion: 'drag',
        borderBottom: '1px solid var(--hair)',
        background: 'var(--paper-sink)',
      }}
    >
      <Group gap={8} align='center'>
        <LoreLogo variant='mark' height='16px' />
        <Text size='xs' fw={600} c='dimmed'>
          {titleSuffix ? `Lore MiniPlayer — ${titleSuffix}` : 'Lore MiniPlayer'}
        </Text>
      </Group>
      <Group gap={8} style={{ WebkitAppRegion: 'no-drag' }}>
        {onCollapse && (
          <ActionIcon
            size='xs'
            variant='subtle'
            onClick={onCollapse}
            radius='sm'
            aria-label='Collapse to pill'
          >
            <IconChevronDown size={12} />
          </ActionIcon>
        )}
        <ActionIcon
          size='xs'
          variant='subtle'
          onClick={() => window.electronAPI.window.minimize()}
          radius='sm'
        >
          <IconMinus size={12} />
        </ActionIcon>
        <ActionIcon
          size='xs'
          variant='subtle'
          onClick={() => window.electronAPI.window.close()}
          radius='sm'
          color='red'
        >
          <IconX size={12} />
        </ActionIcon>
      </Group>
    </Group>
  );
}
