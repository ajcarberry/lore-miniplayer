import type { ReactElement } from 'react';
import { Center, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconGitMerge } from '@tabler/icons-react';
import type { ReviewOpenRequest } from '../../../shared/types';

export interface MergeWorkflowStubProps {
  readonly request: ReviewOpenRequest;
}

// The review window's merge workflow (design 2c) is implemented in P14. This
// packet plumbs the merge mode through for real — Mission Control's Merge
// action opens the window with workflow 'merge' — and routes it to this honest
// placeholder so the mode wiring is exercised end to end.
export function MergeWorkflowStub(props: MergeWorkflowStubProps): ReactElement {
  return (
    <Center h='100%' p='xl'>
      <Stack align='center' gap='sm' maw={420}>
        <ThemeIcon size='xl' radius='xl' variant='light'>
          <IconGitMerge size={22} />
        </ThemeIcon>
        <Text ff='var(--font-disp)' fw={600} size='lg'>
          Merge review is coming soon
        </Text>
        <Text size='sm' c='dimmed' ta='center'>
          {`Merging ${props.request.branchName} → main with accept-mine / accept-theirs conflict resolution lands in a later update.`}
        </Text>
      </Stack>
    </Center>
  );
}
