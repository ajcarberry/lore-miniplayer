import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Group, Stack } from '@mantine/core';
import type {
  FileDiffResult,
  LoreFileStatusGroup,
  Result,
  ReviewCompare,
  ReviewOpenRequest,
} from '../../../shared/types';
import { notifyError } from '../../utils/notify';
import { ComparePicker } from './ComparePicker';
import { FileList } from './FileList';
import { DiffPane } from './DiffPane';
import { CommitBar } from './CommitBar';
import { ReviewHeader } from './ReviewHeader';
import { useReviewMeta } from './useReviewMeta';
import { composeReviewFiles, compareTargetLabel } from './reviewModel';

export interface CommitReviewProps {
  readonly request: ReviewOpenRequest;
  // Morph back to the card.
  readonly onExit: () => void;
}

const EMPTY_STATUS: LoreFileStatusGroup = { untracked: [], unstaged: [], staged: [] };

// The review window's commit workflow (design 2b): the compare picker drives a
// diff.compare over the workspace checkout, the file list stages/unstages via
// the working-tree status, and the bottom bar commits the staged files (then
// offers Push). All Lore IPC targets the workspace path (the checkout is the
// repository for these calls).
export function CommitReview(props: CommitReviewProps): ReactElement {
  const { request } = props;
  const repositoryPath = request.repositoryPath;

  const [compare, setCompare] = useState<ReviewCompare>(request.compare);
  const [diffs, setDiffs] = useState<FileDiffResult[]>([]);
  const [status, setStatus] = useState<LoreFileStatusGroup>(EMPTY_STATUS);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const { repositoryName, revisions } = useReviewMeta(
    repositoryPath,
    request.repositoryId,
    request.branchName
  );
  const [message, setMessage] = useState<string>('');
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [pushing, setPushing] = useState(false);

  // Initial state (compare) is seeded from `request` and re-seeded by a
  // remount when the request changes (keyed in ReviewWindow), so no reset effect
  // is needed here.

  // The one status-result handler — the mount/compare effect and the
  // callback-driven refreshes share it, so success/error handling lives in a
  // single place.
  const applyStatusResult = useCallback((result: Result<LoreFileStatusGroup>): void => {
    if (result.success) {
      setStatus(result.data);
    } else {
      notifyError('Could not load file status', result.error);
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    applyStatusResult(await window.electronAPI.lore.files.getStatus(repositoryPath));
  }, [repositoryPath, applyStatusResult]);

  // Refetch the diff (and status) whenever the compare selection changes. Both
  // fetches set state only inside their resolved promises (never synchronously
  // in the effect body).
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.diff
      .compare({ repositoryPath, source: compare.source, target: compare.target })
      .then(result => {
        if (cancelled) {
          return;
        }
        if (result.success) {
          setDiffs(result.data);
          setSelectedPath(prev =>
            prev && result.data.some(file => file.path === prev)
              ? prev
              : (result.data[0]?.path ?? null)
          );
        } else {
          notifyError('Could not load diff', result.error);
        }
      });
    void window.electronAPI.lore.files.getStatus(repositoryPath).then(result => {
      if (!cancelled) {
        applyStatusResult(result);
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [repositoryPath, compare, applyStatusResult]);

  const files = useMemo(() => composeReviewFiles(diffs, status), [diffs, status]);
  const stagedCount = files.filter(file => file.staged).length;
  const selectedFile = files.find(file => file.path === selectedPath) ?? null;

  const handleToggleStage = useCallback(
    (path: string, nextStaged: boolean): void => {
      const call = nextStaged
        ? window.electronAPI.lore.files.stage(repositoryPath, [path])
        : window.electronAPI.lore.files.unstage(repositoryPath, [path]);
      void call.then(result => {
        if (!result.success) {
          notifyError(nextStaged ? 'Stage failed' : 'Unstage failed', result.error);
          return;
        }
        void refreshStatus();
      });
    },
    [repositoryPath, refreshStatus]
  );

  const handleCommit = useCallback((): void => {
    setCommitting(true);
    void window.electronAPI.lore.repository
      .commit(repositoryPath, message.trim())
      .then(result => {
        if (result.success) {
          setCommitted(true);
          void refreshStatus();
        } else {
          notifyError('Commit failed', result.error);
        }
      })
      .finally(() => setCommitting(false));
  }, [repositoryPath, message, refreshStatus]);

  const handlePush = useCallback((): void => {
    setPushing(true);
    void window.electronAPI.lore.repository
      .push(repositoryPath)
      .then(result => {
        if (!result.success) {
          notifyError('Push failed', result.error);
        }
      })
      .finally(() => setPushing(false));
  }, [repositoryPath]);

  const compareLabel = `${compareTargetLabel(compare.source)} → ${compareTargetLabel(compare.target)}`;

  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      <ReviewHeader
        onBack={props.onExit}
        title={`Review — ${request.branchName}`}
        eyebrow={repositoryName ? `${repositoryName} · ${request.branchName}` : request.branchName}
        right={<ComparePicker compare={compare} revisions={revisions} onChange={setCompare} />}
      />

      <Group gap={0} align='stretch' wrap='nowrap' style={{ flex: 1, minHeight: 0 }}>
        <Box w={250} style={{ minHeight: 0 }}>
          <FileList
            files={files}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            onToggleStage={handleToggleStage}
          />
        </Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <DiffPane file={selectedFile} compareLabel={compareLabel} />
        </Box>
      </Group>

      <CommitBar
        stagedCount={stagedCount}
        totalCount={files.length}
        message={message}
        onMessageChange={setMessage}
        onCommit={handleCommit}
        committing={committing}
        committed={committed}
        onPush={handlePush}
        pushing={pushing}
      />
    </Stack>
  );
}
