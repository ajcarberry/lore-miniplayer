import type { ReactElement } from 'react';
import { Divider, Group, Stack, Text } from '@mantine/core';
import type { MergeFileState, RevisionSummary } from '../../../shared/types';
import { SectionLabel } from '../SectionLabel';

export interface MergeSidebarProps {
  readonly targetBranch: string;
  readonly revisions: readonly RevisionSummary[];
  readonly conflictFiles: readonly MergeFileState[];
}

// The review window's merge sidebar: the commits the merge brings onto the
// target ("Merging commits") and the per-file conflicts ledger recording
// which side was kept.
export function MergeSidebar(props: MergeSidebarProps): ReactElement {
  const { targetBranch, revisions, conflictFiles } = props;

  return (
    <Stack gap={0} h='100%' style={{ borderLeft: '1px solid var(--hairline, rgba(43,36,22,.1))' }}>
      <Stack gap={6} p='md'>
        <SectionLabel lts='0.12em'>Merging commits</SectionLabel>
        {revisions.length === 0 ? (
          <Text size='xs' c='dimmed'>
            No commits ahead of {targetBranch}.
          </Text>
        ) : (
          revisions.map(rev => (
            <Group key={rev.revision} gap={8} wrap='nowrap'>
              <Text ff='var(--font-mono)' size='xs' c='dimmed'>
                {rev.revision}
              </Text>
              <Text size='xs' truncate style={{ flex: 1, minWidth: 0 }}>
                {rev.message ?? ''}
              </Text>
            </Group>
          ))
        )}
      </Stack>

      <Divider />

      <Stack gap={6} p='md'>
        <SectionLabel lts='0.12em'>Conflicts</SectionLabel>
        {conflictFiles.length === 0 ? (
          <Text size='xs' c='dimmed'>
            No conflicts.
          </Text>
        ) : (
          conflictFiles.map(file => (
            <Group key={file.path} gap={8} wrap='nowrap'>
              <Text ff='var(--font-mono)' size='xs' truncate style={{ flex: 1, minWidth: 0 }}>
                {file.path}
              </Text>
              <Text size='xs' c={file.resolution ? 'green' : 'orange'}>
                {file.resolution ? `kept ${file.resolution}` : 'unresolved'}
              </Text>
            </Group>
          ))
        )}
      </Stack>
    </Stack>
  );
}
