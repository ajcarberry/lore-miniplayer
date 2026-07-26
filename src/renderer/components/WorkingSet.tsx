import type { ReactElement } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Collapse,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';

export interface WorkingSetFile {
  readonly path: string;
  readonly kind: 'add' | 'edit';
  readonly staged: boolean;
}

export interface WorkingSetProps {
  readonly files: WorkingSetFile[];
  readonly open: boolean;
  readonly onToggleOpen: () => void;
  readonly onToggleFile: (path: string) => void;
  readonly isLoading: boolean;
  // Open the review window's commit workflow over the selected repository;
  // omitted while no repository is on disk (clone pending).
  readonly onReview?: () => void;
  // Open the review window's merge workflow; omitted when the branch has no
  // distinct merge target.
  readonly onMerge?: () => void;
}

// Splits a relative path into its dimmed directory prefix (including the
// trailing slash) and the filename that stays fully visible.
function splitPath(path: string): { dir: string; filename: string } {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex === -1) {
    return { dir: '', filename: path };
  }
  return { dir: path.slice(0, slashIndex + 1), filename: path.slice(slashIndex + 1) };
}

interface FileRowProps {
  readonly file: WorkingSetFile;
  readonly onToggleFile: (path: string) => void;
}

function FileRow({ file, onToggleFile }: FileRowProps): ReactElement {
  const { dir, filename } = splitPath(file.path);
  return (
    <Box
      p='4px 8px'
      style={{ cursor: 'pointer', borderRadius: '4px' }}
      onClick={() => onToggleFile(file.path)}
    >
      <Group gap={6} wrap='nowrap'>
        <Checkbox
          size='xs'
          checked={file.staged}
          onChange={() => onToggleFile(file.path)}
          onClick={event => event.stopPropagation()}
          aria-label={file.path}
        />
        <Text
          size='xs'
          fw={700}
          c={file.kind === 'add' ? 'green' : 'var(--acc)'}
          style={{ width: 12, flexShrink: 0 }}
        >
          {file.kind === 'add' ? 'A' : 'M'}
        </Text>
        <Group gap={0} wrap='nowrap' style={{ flex: 1, minWidth: 0 }}>
          {dir && (
            <Text size='xs' c='dimmed' truncate='start' style={{ minWidth: 0 }}>
              {dir}
            </Text>
          )}
          <Text size='xs' style={{ flexShrink: 0 }}>
            {filename}
          </Text>
        </Group>
      </Group>
    </Box>
  );
}

// The card's working-set section: a collapsible header (label + staged/
// changed meta + chevron) over the transfer-list-backed file list. Each row
// toggles staged/unstaged on click, mirroring the checkbox state.
export function WorkingSet({
  files,
  open,
  onToggleOpen,
  onToggleFile,
  isLoading,
  onReview,
  onMerge,
}: WorkingSetProps): ReactElement {
  const stagedCount = files.filter(file => file.staged).length;
  const meta = isLoading
    ? 'Loading…'
    : files.length === 0
      ? 'clean'
      : `${stagedCount} staged · ${files.length} changed`;
  const showContent = open && (isLoading || files.length > 0);

  return (
    <Box>
      <Box
        p='4px 0'
        style={{ cursor: 'pointer' }}
        onClick={onToggleOpen}
        role='button'
        tabIndex={0}
      >
        <Group justify='space-between' wrap='nowrap'>
          <Text size='xs' fw={700} tt='uppercase' c='dimmed'>
            Working Set
          </Text>
          <Group gap={6} wrap='nowrap'>
            {onReview && (
              <Button
                size='compact-xs'
                variant='subtle'
                onClick={event => {
                  event.stopPropagation();
                  onReview();
                }}
              >
                Review
              </Button>
            )}
            {onMerge && (
              <Button
                size='compact-xs'
                variant='subtle'
                onClick={event => {
                  event.stopPropagation();
                  onMerge();
                }}
              >
                Merge
              </Button>
            )}
            <Text size='xs' c='dimmed'>
              {meta}
            </Text>
            <IconChevronDown
              size={14}
              style={{
                transform: open ? 'rotate(180deg)' : undefined,
                transition: 'transform 0.15s ease',
              }}
            />
          </Group>
        </Group>
      </Box>
      <Collapse expanded={showContent} keepMounted={false}>
        {showContent && (
          <ScrollArea.Autosize mah={140} offsetScrollbars>
            {isLoading ? (
              <Box p='8px' style={{ textAlign: 'center' }}>
                <Loader size='xs' />
              </Box>
            ) : (
              <Stack gap={0}>
                {files.map(file => (
                  <FileRow key={file.path} file={file} onToggleFile={onToggleFile} />
                ))}
              </Stack>
            )}
          </ScrollArea.Autosize>
        )}
      </Collapse>
    </Box>
  );
}
