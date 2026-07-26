import type { ReactElement, ReactNode } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';

export interface ReviewHeaderProps {
  readonly title: string;
  // The mono sub-line under the title ("<repo> · <branch>" / tally).
  readonly eyebrow: string;
  // Optional leading glyph (the merge workflow's IconGitMerge).
  readonly icon?: ReactNode;
  // Optional right-aligned slot (the commit workflow's compare picker).
  readonly right?: ReactNode;
}

// The review window's shared header shell (designs 2b/2c): hairline-bottomed
// row with the display-face title over a mono eyebrow, plus optional leading
// icon and right-aligned slot.
export function ReviewHeader(props: ReviewHeaderProps): ReactElement {
  return (
    <Group
      px='md'
      py='sm'
      gap='sm'
      wrap='nowrap'
      style={{ borderBottom: '1px solid var(--hairline, rgba(43,36,22,.1))' }}
    >
      {props.icon}
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text
          component='h1'
          ff='var(--font-disp)'
          fw={600}
          style={{ fontSize: 15, margin: 0 }}
          truncate
        >
          {props.title}
        </Text>
        <Text size='xs' ff='var(--font-mono)' c='dimmed'>
          {props.eyebrow}
        </Text>
      </Stack>
      {props.right !== undefined && <Box ml='auto'>{props.right}</Box>}
    </Group>
  );
}
