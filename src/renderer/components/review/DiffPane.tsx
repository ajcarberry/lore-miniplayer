import type { ReactElement } from 'react';
import { Alert, Box, Center, Group, Stack, Text } from '@mantine/core';
import { IconFileText } from '@tabler/icons-react';
import type { DiffLineKind, ReviewFile } from './reviewModel';
import { DIFF_TONE_BG, parseHunks } from './reviewModel';

export interface DiffPaneProps {
  readonly file: ReviewFile | null;
  // The compare picker's current source→target label, echoed above the diff
  // (design 2b: "levels/.../encounters.toml · r128 → working tree").
  readonly compareLabel: string;
}

const LINE_BG: Record<DiffLineKind, string> = {
  add: DIFF_TONE_BG.add,
  del: DIFF_TONE_BG.del,
  context: 'transparent',
};

const MARK: Record<DiffLineKind, string> = { add: '+', del: '−', context: '' };

// The review window's center pane (design 2b): the selected file's unified diff
// rendered hunk by hunk. Binary files and empty diffs show a notice instead of
// a patch; a truncated patch (P4's cap) is flagged so the reviewer knows the
// tail is elided. Only the selected file's patch is ever parsed/rendered, which
// keeps large multi-file compares cheap.
export function DiffPane(props: DiffPaneProps): ReactElement {
  const { file, compareLabel } = props;

  if (!file) {
    return (
      <Center h='100%'>
        <Text size='sm' c='dimmed'>
          Select a file to view its diff
        </Text>
      </Center>
    );
  }

  // Parsed once per render — the emptiness check and the hunk map below share
  // this, so a large capped patch is never parsed twice.
  const hunks = file.binary ? [] : parseHunks(file.patch ?? '');

  return (
    <Stack gap={0} h='100%' style={{ overflow: 'hidden' }}>
      <Group gap={6} px={18} py={8} wrap='nowrap'>
        <IconFileText size={13} color='var(--ink-40, rgba(43,36,22,.55))' />
        <Text size='xs' c='dimmed' truncate>
          {`${file.path} · ${compareLabel}`}
        </Text>
      </Group>

      {file.binary ? (
        <Box px={18} py={12}>
          <Alert color='gray' variant='light'>
            Binary file — changed, no textual diff to show.
          </Alert>
        </Box>
      ) : (
        <Box style={{ flex: 1, overflow: 'auto' }} ff='var(--font-mono)'>
          {file.truncated && (
            <Box px={18} py={8}>
              <Alert color='yellow' variant='light' title='Diff truncated'>
                This diff is large and has been truncated; only the first part is shown.
              </Alert>
            </Box>
          )}
          {hunks.length === 0 ? (
            <Text px={18} py={12} size='sm' c='dimmed'>
              No textual changes to display.
            </Text>
          ) : (
            hunks.map(hunk => (
              <Box key={`${hunk.header}:${hunk.lines[0]?.lineNo ?? 0}`}>
                <Box
                  px={18}
                  py={2}
                  style={{
                    background: 'var(--paper-sink, rgba(43,36,22,.04))',
                    color: 'var(--ink-40, rgba(43,36,22,.45))',
                  }}
                >
                  <Text size='xs' ff='var(--font-mono)'>
                    {hunk.header}
                  </Text>
                </Box>
                {hunk.lines.map(line => (
                  <Group
                    key={`${line.kind}:${line.lineNo ?? ''}:${line.text}`}
                    gap={0}
                    wrap='nowrap'
                    px={18}
                    py={2}
                    style={{ background: LINE_BG[line.kind] }}
                  >
                    <Text size='xs' ff='var(--font-mono)' c='dimmed' w={34} ta='right' pr={8}>
                      {line.kind === 'del' ? MARK.del : (line.lineNo ?? '')}
                    </Text>
                    <Text size='xs' ff='var(--font-mono)' style={{ whiteSpace: 'pre-wrap' }}>
                      {`${MARK[line.kind]}${MARK[line.kind] ? ' ' : ''}${line.text}`}
                    </Text>
                  </Group>
                ))}
              </Box>
            ))
          )}
        </Box>
      )}
    </Stack>
  );
}
