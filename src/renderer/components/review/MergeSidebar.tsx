import type { ReactElement } from 'react';
import { Box, Divider, Group, Stack, Text } from '@mantine/core';
import type { MergeFileState, RevisionSummary } from '../../../shared/types';
import { IntentionPanel } from './IntentionPanel';

export interface MergeSidebarProps {
  readonly repositoryId: string;
  readonly workspacePath: string;
  readonly targetBranch: string;
  readonly revisions: readonly RevisionSummary[];
  readonly conflictFiles: readonly MergeFileState[];
}

const SECTION_LABEL = {
  size: 'xs',
  fw: 600,
  tt: 'uppercase',
  c: 'dimmed',
  style: { letterSpacing: '0.12em' },
} as const;

// The review window's merge sidebar (design 2c): the commits the merge brings
// onto the target ("Merging commits"), the per-file conflicts ledger recording
// which side was kept, and — below — the agent's intention (Asked / Task list /
// Agent's account) via the shared IntentionPanel, which sources the workspace's
// AgentIntention and degrades to its own placeholder when none was recorded.
export function MergeSidebar(props: MergeSidebarProps): ReactElement {
  const { targetBranch, revisions, conflictFiles } = props;

  return (
    <Stack gap={0} h='100%' style={{ borderLeft: '1px solid var(--hairline, rgba(43,36,22,.1))' }}>
      <Stack gap={6} p='md'>
        <Text {...SECTION_LABEL}>Merging commits</Text>
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
        <Text {...SECTION_LABEL}>Conflicts</Text>
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

      <Divider />

      <Box style={{ flex: 1, minHeight: 0 }}>
        <IntentionPanel repositoryId={props.repositoryId} workspacePath={props.workspacePath} />
      </Box>
    </Stack>
  );
}
