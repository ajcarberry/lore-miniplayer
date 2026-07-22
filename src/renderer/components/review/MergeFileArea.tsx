import type { ReactElement } from 'react';
import { Alert, Group, ScrollArea, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import type { FileDiffResult, MergeFileResolution, MergeFileState } from '../../../shared/types';
import { ConflictBlock } from './ConflictBlock';

export interface MergeFileAreaProps {
  readonly targetBranch: string;
  readonly sourceBranch: string;
  readonly landedRevision: string | null;
  readonly mergedFiles: readonly MergeFileState[];
  readonly conflictFiles: readonly MergeFileState[];
  readonly bothSides: Map<string, FileDiffResult>;
  readonly resolvingPath: string | null;
  readonly onResolve: (path: string, resolution: MergeFileResolution) => void;
}

// The review window's merge center pane (design 2c): a landed-merge banner once
// the merge completes, the inert auto-merged files list with its guidance note,
// then a conflict block per unresolved/resolved conflicted file.
export function MergeFileArea(props: MergeFileAreaProps): ReactElement {
  const { targetBranch, sourceBranch, landedRevision, mergedFiles, conflictFiles } = props;

  return (
    <ScrollArea h='100%' type='auto'>
      <Stack gap='md' p='md'>
        {landedRevision !== null && (
          <Alert color='green' variant='light' title='Merge landed'>
            {`Merged — landed ${landedRevision} on ${targetBranch}. This branch can be closed from Mission Control.`}
          </Alert>
        )}

        {mergedFiles.length > 0 && (
          <Stack gap={6}>
            <Text size='xs' fw={600} tt='uppercase' c='dimmed' style={{ letterSpacing: '0.12em' }}>
              Auto-merged files need no action
            </Text>
            {mergedFiles.map(file => (
              <Group key={file.path} gap={7} wrap='nowrap' px={4}>
                <IconCheck size={14} color='oklch(0.5 0.1 150)' />
                <Text ff='var(--font-mono)' size='sm' c='dimmed' truncate>
                  {file.path}
                </Text>
              </Group>
            ))}
          </Stack>
        )}

        {conflictFiles.map(file => (
          <ConflictBlock
            key={file.path}
            path={file.path}
            diff={props.bothSides.get(file.path)}
            resolution={file.resolution}
            theirsLabel={`Theirs — ${targetBranch}`}
            mineLabel={`Mine — ${sourceBranch}`}
            resolving={props.resolvingPath === file.path}
            onResolve={resolution => props.onResolve(file.path, resolution)}
          />
        ))}

        {conflictFiles.length === 0 && mergedFiles.length === 0 && (
          <Text size='sm' c='dimmed'>
            Nothing to merge — the branches are already in sync.
          </Text>
        )}
      </Stack>
    </ScrollArea>
  );
}
