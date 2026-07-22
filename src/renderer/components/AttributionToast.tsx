import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { ActionIcon, Group, Paper, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import classes from './AttributionToast.module.css';

export interface AttributionToastProps {
  readonly message: string;
  readonly onDismiss: () => void;
  readonly durationMs?: number;
}

const DEFAULT_DURATION_MS = 5000;

// The card-top attribution toast (design 1c): "Mara Voss pushed r128 to
// feature/act-two", auto-dismissing after 5s with a draining underline, or
// closed early with ✕. The caller (MiniPlayer) owns the one-at-a-time
// queue via useAttributionToasts and remounts this component per toast
// (fresh key), so its own timer/animation always start clean.
export function AttributionToast({
  message,
  onDismiss,
  durationMs = DEFAULT_DURATION_MS,
}: AttributionToastProps): ReactElement {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, durationMs);
    return (): void => window.clearTimeout(timer);
  }, [onDismiss, durationMs]);

  return (
    <Paper
      withBorder
      radius='md'
      shadow='md'
      px='sm'
      py={6}
      style={{ position: 'relative', background: 'var(--paper-raised)', overflow: 'hidden' }}
    >
      <Group gap={8} wrap='nowrap' align='center'>
        <Text size='xs' style={{ flex: 1 }}>
          {message}
        </Text>
        <ActionIcon
          size='xs'
          variant='subtle'
          color='gray'
          aria-label='Dismiss'
          onClick={onDismiss}
        >
          <IconX size={12} />
        </ActionIcon>
      </Group>
      <span
        aria-hidden
        className={classes.underline}
        style={{ animationDuration: `${durationMs}ms` }}
      />
    </Paper>
  );
}
