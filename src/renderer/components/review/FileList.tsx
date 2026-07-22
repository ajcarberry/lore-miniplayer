import type { ReactElement } from 'react';
import {
  Box,
  Checkbox,
  Group,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReviewFile } from './reviewModel';
import { totalLineStats } from './reviewModel';

export interface FileListProps {
  readonly files: readonly ReviewFile[];
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
  readonly onToggleStage: (path: string, nextStaged: boolean) => void;
}

// Maps a diff action to its single-letter badge and semantic colour (design 2b:
// M amber, A green, D/moved muted).
const ACTION_BADGE: Record<ReviewFile['action'], { letter: string; color: string }> = {
  modified: { letter: 'M', color: 'var(--acc-deep, #7a5b1e)' },
  added: { letter: 'A', color: 'oklch(0.5 0.1 150)' },
  deleted: { letter: 'D', color: 'oklch(0.5 0.12 25)' },
  moved: { letter: 'R', color: 'var(--ink-40, rgba(43,36,22,.6))' },
};

function statsLabel(file: ReviewFile): string {
  if (file.binary) {
    return 'binary';
  }
  if (!file.lineStats) {
    return '';
  }
  const parts: string[] = [];
  if (file.lineStats.added > 0) {
    parts.push(`+${file.lineStats.added}`);
  }
  if (file.lineStats.removed > 0) {
    parts.push(`−${file.lineStats.removed}`);
  }
  return parts.join(' ');
}

// The review window's left pane (design 2b): a header summarising the changed
// files and aggregate line stats, then a stage-checkbox row per file. Binary
// rows show "binary" instead of stats; a still-unresolved conflict disables its
// checkbox and flags it with a warning (P6) — it cannot be staged until
// resolved.
export function FileList(props: FileListProps): ReactElement {
  const { files, selectedPath } = props;
  const total = totalLineStats(files);

  return (
    <Stack
      gap={2}
      p='xs'
      h='100%'
      style={{
        background: 'var(--paper-sink, #efe9db)',
        borderRight: '1px solid var(--hairline, rgba(43,36,22,.1))',
      }}
    >
      <Text
        size='xs'
        fw={600}
        tt='uppercase'
        c='dimmed'
        px='xs'
        pb={4}
        style={{ letterSpacing: '0.12em' }}
      >
        {`${files.length} ${files.length === 1 ? 'file' : 'files'} · +${total.added} −${total.removed} · stage for commit`}
      </Text>
      <ScrollArea.Autosize mah='100%' style={{ flex: 1 }}>
        <Stack gap={2}>
          {files.map(file => {
            const badge = ACTION_BADGE[file.action];
            const isSelected = file.path === selectedPath;
            const canStage = !file.conflictUnresolved;
            return (
              <Group
                key={file.path}
                gap={7}
                wrap='nowrap'
                px={9}
                py={7}
                style={{
                  borderRadius: 7,
                  background: isSelected ? 'var(--acc-soft, oklch(0.88 0.045 74))' : 'transparent',
                  opacity: canStage ? 1 : 0.75,
                }}
              >
                {file.conflictUnresolved ? (
                  <Tooltip label='Resolve the conflict before staging' withinPortal>
                    <IconAlertTriangle
                      size={13}
                      color='oklch(0.55 0.14 60)'
                      aria-label={`${file.path} has an unresolved conflict`}
                    />
                  </Tooltip>
                ) : (
                  <Checkbox
                    size='xs'
                    checked={file.staged}
                    aria-label={`Stage ${file.path}`}
                    onChange={event => props.onToggleStage(file.path, event.currentTarget.checked)}
                  />
                )}
                <Text ff='var(--font-mono)' fw={700} size='xs' c={badge.color} w={12}>
                  {badge.letter}
                </Text>
                <UnstyledButton
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => props.onSelect(file.path)}
                >
                  <Text ff='var(--font-mono)' size='sm' truncate>
                    {file.path}
                  </Text>
                </UnstyledButton>
                <Box>
                  <Text ff='var(--font-mono)' size='xs' c='dimmed'>
                    {statsLabel(file)}
                  </Text>
                </Box>
              </Group>
            );
          })}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}
