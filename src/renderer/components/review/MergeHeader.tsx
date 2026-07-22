import type { ReactElement } from 'react';
import { Group, Stack, Text } from '@mantine/core';
import { IconGitMerge } from '@tabler/icons-react';

export interface MergeHeaderProps {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly repositoryName: string | null;
  readonly commitCount: number;
  readonly conflictCount: number;
}

// The eyebrow: "<repo> · N commits · M conflicts".
function formatEyebrow(
  repositoryName: string | null,
  commitCount: number,
  conflictCount: number
): string {
  const commits = `${commitCount} ${commitCount === 1 ? 'commit' : 'commits'}`;
  const conflicts = `${conflictCount} ${conflictCount === 1 ? 'conflict' : 'conflicts'}`;
  return `${repositoryName ? `${repositoryName} · ` : ''}${commits} · ${conflicts}`;
}

// The review window's merge header (design 2c): "Merge — <branch> → <target>"
// with a commit/conflict tally eyebrow.
export function MergeHeader(props: MergeHeaderProps): ReactElement {
  return (
    <Group
      px='md'
      py='sm'
      gap='sm'
      wrap='nowrap'
      style={{ borderBottom: '1px solid var(--hairline, rgba(43,36,22,.1))' }}
    >
      <IconGitMerge size={18} color='var(--acc-deep, #7a5b1e)' />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text
          component='h1'
          ff='var(--font-disp)'
          fw={600}
          style={{ fontSize: 15, margin: 0 }}
          truncate
        >
          {`Merge — ${props.sourceBranch} → ${props.targetBranch}`}
        </Text>
        <Text size='xs' ff='var(--font-mono)' c='dimmed'>
          {formatEyebrow(props.repositoryName, props.commitCount, props.conflictCount)}
        </Text>
      </Stack>
    </Group>
  );
}
