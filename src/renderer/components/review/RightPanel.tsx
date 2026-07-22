import type { ReactElement, ReactNode } from 'react';
import { Box, Stack, Text } from '@mantine/core';

export interface RightPanelProps {
  // P12 fills the intention region (Asked / Task list / Agent's account). This
  // packet renders a placeholder so the three-pane layout is final and P12
  // slots in without reworking it. A `session` footer slot is reserved for the
  // "from transcript · session · $cost" line P12 also owns.
  readonly children?: ReactNode;
  readonly session?: ReactNode;
}

// The review window's right pane (design 2b): the intention column. Structured
// now (region + footer slot) and filled by P12; until then it shows a quiet
// placeholder so the layout is stable.
export function RightPanel(props: RightPanelProps): ReactElement {
  return (
    <Stack
      gap={14}
      p='md'
      h='100%'
      style={{ borderLeft: '1px solid var(--hairline, rgba(43,36,22,.1))' }}
    >
      <Box style={{ flex: 1 }} data-testid='review-intention-region'>
        {props.children ?? (
          <Text size='sm' c='dimmed'>
            The agent&apos;s intention — what it was asked, its task list, and its own account —
            appears here beside the diff.
          </Text>
        )}
      </Box>
      <Box data-testid='review-session-footer'>{props.session}</Box>
    </Stack>
  );
}
