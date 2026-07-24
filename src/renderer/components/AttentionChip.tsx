import type { MouseEvent, PointerEvent, ReactElement } from 'react';
import { Group, Text, UnstyledButton } from '@mantine/core';
import { IconPlayerPlayFilled } from '@tabler/icons-react';
import { pluralize } from '../utils/pluralize';

export interface AttentionChipProps {
  readonly needsYouCount: number;
  readonly activeCount: number;
  readonly onOpen: () => void;
}

// The one aggregate attention glyph joining the pill's/card's signal row
// (design 1b/1c): amber dot + count when ≥1 workspace needs the human
// (needsYou wins the tri-state), a quiet hairline play chip + count when
// agents are working and nothing needs you, nothing when everything is
// idle. Click opens Mission Control — stopPropagation so it never also
// expands the card or opens the branch switcher, mirroring the pill's
// close control. Rendered as a single parameterized chip; kept an
// UnstyledButton (the bespoke pulse-dot/gradient styling is not a Badge
// variant) inside PlayerHeader's role='button' Box — see PlayerHeader's
// nested-interactive note.
export function AttentionChip({
  needsYouCount,
  activeCount,
  onOpen,
}: AttentionChipProps): ReactElement | null {
  if (needsYouCount === 0 && activeCount === 0) {
    return null;
  }

  const stopPointer = (event: PointerEvent): void => event.stopPropagation();
  const handleClick = (event: MouseEvent): void => {
    event.stopPropagation();
    onOpen();
  };

  const needsYou = needsYouCount > 0;
  const count = needsYou ? needsYouCount : activeCount;
  const label = needsYou
    ? `${needsYouCount} ${pluralize(needsYouCount, 'workspace')} need${needsYouCount === 1 ? 's' : ''} you — open Mission Control`
    : `${activeCount} ${pluralize(activeCount, 'agent')} working, none need you`;

  return (
    <UnstyledButton
      aria-label={label}
      title={label}
      onClick={handleClick}
      onPointerDown={stopPointer}
      onPointerUp={stopPointer}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        borderRadius: 11,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        fontSize: 10.5,
        ...(needsYou
          ? {
              padding: '0 9px',
              background: 'linear-gradient(135deg, oklch(0.66 0.11 74), oklch(0.46 0.10 74))',
              color: '#fff',
            }
          : {
              padding: '0 8px',
              border: '1px solid var(--hair)',
              color: 'var(--ink-faint)',
            }),
      }}
    >
      <Group gap={5} wrap='nowrap' align='center'>
        {needsYou ? (
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#fff',
              animation: 'pulseDot 2s infinite',
            }}
          />
        ) : (
          <IconPlayerPlayFilled size={8} />
        )}
        <Text component='span' inherit>
          {count}
        </Text>
      </Group>
    </UnstyledButton>
  );
}
