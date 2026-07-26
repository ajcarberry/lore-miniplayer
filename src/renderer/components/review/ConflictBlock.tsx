import type { ReactElement } from 'react';
import { Alert, Badge, Box, Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { FileDiffResult, MergeFileResolution } from '../../../shared/types';
import { SectionLabel } from '../SectionLabel';
import { DIFF_TONE_BG, parseHunks } from './reviewModel';

export interface ConflictBlockProps {
  readonly path: string;
  // Both-sides content for the file, fetched through the diff bridge
  // (theirs = target head on the "old" side, mine = source head on the "new"
  // side). Undefined until the fetch resolves, or when the file is binary.
  readonly diff: FileDiffResult | undefined;
  readonly resolution: MergeFileResolution | undefined;
  readonly theirsLabel: string;
  readonly mineLabel: string;
  readonly resolving: boolean;
  readonly onResolve: (resolution: MergeFileResolution) => void;
}

// One side of the conflict (the theirs or mine column). The side's lines are
// rendered as a single pre-wrapped block, so identical lines need no per-line
// keys.
function SideColumn(props: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly tone: 'theirs' | 'mine';
}): ReactElement {
  return (
    <Box style={{ flex: 1, minWidth: 0 }}>
      <SectionLabel px={10} py={4} lts='0.08em'>
        {props.title}
      </SectionLabel>
      <Box
        px={10}
        py={6}
        style={{
          background: props.tone === 'theirs' ? DIFF_TONE_BG.del : DIFF_TONE_BG.add,
          minHeight: 44,
        }}
      >
        {props.lines.length === 0 ? (
          <Text size='xs' ff='var(--font-mono)' c='dimmed' style={{ whiteSpace: 'pre-wrap' }}>
            (empty)
          </Text>
        ) : (
          <Text size='xs' ff='var(--font-mono)' style={{ whiteSpace: 'pre-wrap' }}>
            {props.lines.join('\n')}
          </Text>
        )}
      </Box>
    </Box>
  );
}

// The merge workflow's per-file conflict block: the conflicted file's
// two sides side by side — THEIRS (the target/main branch) and MINE (the
// source branch) — with accept-theirs / accept-mine resolution.
// Native resolution is per FILE, so one choice applies to the whole file;
// when the diff spans more than one region that is stated explicitly. The
// accepted side persists (the button stays filled and a badge marks it) so a
// re-review is unambiguous.
export function ConflictBlock(props: ConflictBlockProps): ReactElement {
  const { path, diff, resolution, resolving } = props;
  const hunks = diff && !diff.binary ? parseHunks(diff.patch ?? '') : [];
  const multiRegion = hunks.length > 1;

  // Theirs = the "old" side (context + removed); mine = the "new" side
  // (context + added). Blank-line context is preserved so the columns align.
  const theirsLines = hunks.flatMap(hunk =>
    hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
  );
  const mineLines = hunks.flatMap(hunk =>
    hunk.lines.filter(line => line.kind !== 'del').map(line => line.text)
  );

  return (
    <Box
      data-testid={`conflict-block-${path}`}
      style={{
        border: '1px solid var(--hairline, rgba(43,36,22,.12))',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <Group
        gap={7}
        wrap='nowrap'
        px={12}
        py={8}
        style={{ background: 'var(--paper-sink, #efe9db)' }}
      >
        <IconAlertTriangle size={14} color='oklch(0.55 0.14 60)' />
        <Text ff='var(--font-mono)' size='sm' fw={600} truncate style={{ flex: 1, minWidth: 0 }}>
          {path}
        </Text>
        {multiRegion && (
          <Badge size='xs' variant='light' color='orange'>
            applies to whole file
          </Badge>
        )}
      </Group>

      {diff?.binary === true ? (
        <Box px={12} py={10}>
          <Alert color='gray' variant='light'>
            Binary conflict — no textual diff; choose a whole side.
          </Alert>
        </Box>
      ) : diff === undefined ? (
        <Text px={12} py={10} size='sm' c='dimmed'>
          Loading conflict contents…
        </Text>
      ) : (
        <Group gap={0} align='stretch' wrap='nowrap'>
          <SideColumn title={props.theirsLabel} lines={theirsLines} tone='theirs' />
          <Box style={{ width: 1, background: 'var(--hairline, rgba(43,36,22,.12))' }} />
          <SideColumn title={props.mineLabel} lines={mineLines} tone='mine' />
        </Group>
      )}

      <Group
        gap='sm'
        px={12}
        py={8}
        wrap='nowrap'
        style={{ borderTop: '1px solid var(--hairline, rgba(43,36,22,.1))' }}
      >
        <Button
          size='xs'
          variant={resolution === 'theirs' ? 'filled' : 'default'}
          loading={resolving}
          onClick={() => props.onResolve('theirs')}
        >
          Accept theirs
        </Button>
        <Button
          size='xs'
          variant={resolution === 'mine' ? 'filled' : 'default'}
          loading={resolving}
          onClick={() => props.onResolve('mine')}
        >
          Accept mine
        </Button>
        {resolution !== undefined && (
          <Badge ml='auto' size='sm' variant='light' color='green'>
            Accepted
          </Badge>
        )}
      </Group>
    </Box>
  );
}
