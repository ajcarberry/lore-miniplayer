import type { ReactElement, ReactNode } from 'react';
import { Group, Text } from '@mantine/core';

export interface ReviewBottomBarProps {
  // The mono tally at the bar's left ("2 of 4 staged" / "0 of 1 conflicts
  // resolved").
  readonly tally: string;
  readonly children: ReactNode;
}

// The review window's shared bottom-bar shell (designs 2b/2c): hairline-topped
// raised strip holding the mono tally and the workflow's own controls.
export function ReviewBottomBar(props: ReviewBottomBarProps): ReactElement {
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
        {props.tally}
      </Text>
      {props.children}
    </Group>
  );
}
