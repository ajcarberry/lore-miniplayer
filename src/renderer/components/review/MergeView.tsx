import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Center, Group, Loader, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type {
  FileDiffResult,
  MergeFileResolution,
  MergeState,
  ReviewOpenRequest,
  RevisionSummary,
} from '../../../shared/types';
import { AbortMergeModal } from './AbortMergeModal';
import { MergeBar } from './MergeBar';
import { MergeFileArea } from './MergeFileArea';
import { MergeHeader } from './MergeHeader';
import { MergeSidebar } from './MergeSidebar';

export interface MergeViewProps {
  readonly request: ReviewOpenRequest;
}

function notifyError(title: string, error: string): void {
  notifications.show({ color: 'red', title, message: error });
}

// The review window's merge workflow (design 2c). Truthful semantics: the merge
// runs IN the workspace checkout (mine = the workspace/source branch, theirs =
// the target branch, main); resolution is per FILE; and completion lands the
// merge revision on the TARGET branch and pushes it. On mount it starts the
// merge through the merge bridge, fetches both sides of each conflicted file via
// the diff bridge (P2's MergeState carries no content), and drives resolve /
// abort / complete. Errors from start and complete surface as Mantine alerts,
// never silently.
export function MergeView(props: MergeViewProps): ReactElement {
  const { request } = props;
  const repositoryPath = request.workspacePath;
  const sourceBranch = request.branchName;
  const targetBranch =
    request.compare.target.kind === 'branchHead' ? request.compare.target.branch : 'main';

  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [starting, setStarting] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [bothSides, setBothSides] = useState<Map<string, FileDiffResult>>(new Map());
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [repositoryName, setRepositoryName] = useState<string | null>(null);
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [landedRevision, setLandedRevision] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false);

  // Start the merge once (the view remounts per request, so `starting` begins
  // true), then fetch both sides of every conflicted file. Both fetches set
  // state only inside their resolved promises.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.merge
      .start({ repositoryPath, sourceBranch, targetBranch })
      .then(async result => {
        if (cancelled) {
          return;
        }
        if (!result.success) {
          setStartError(result.error);
          setStarting(false);
          return;
        }
        setMergeState(result.data);
        const conflictPaths = result.data.files
          .filter(file => file.state === 'conflict')
          .map(file => file.path);
        if (conflictPaths.length > 0) {
          // Theirs = target head (main) on the diff's source side, mine = source
          // head (branch) on the target side, so removed lines are theirs and
          // added lines are mine.
          const diffResult = await window.electronAPI.diff.compare({
            repositoryPath,
            source: { kind: 'branchHead', branch: targetBranch },
            target: { kind: 'branchHead', branch: sourceBranch },
            paths: conflictPaths,
          });
          if (cancelled) {
            return;
          }
          if (diffResult.success) {
            setBothSides(new Map(diffResult.data.map(diff => [diff.path, diff])));
          } else {
            notifyError('Could not load conflict contents', diffResult.error);
          }
        }
        if (!cancelled) {
          setStarting(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [repositoryPath, sourceBranch, targetBranch]);

  // Resolve the repo name for the eyebrow and load the merging commits (the
  // source branch's revisions).
  useEffect(() => {
    void window.electronAPI.repository.list().then(result => {
      if (result.success) {
        setRepositoryName(result.data.find(repo => repo.id === request.repositoryId)?.name ?? null);
      }
    });
    void window.electronAPI.lore.branchGraph(repositoryPath, sourceBranch).then(result => {
      if (result.success) {
        setRevisions(result.data.branch.revisions);
      }
    });
  }, [repositoryPath, sourceBranch, request.repositoryId]);

  const mergedFiles = useMemo(
    () => (mergeState?.files ?? []).filter(file => file.state === 'merged'),
    [mergeState]
  );
  const conflictFiles = useMemo(
    () => (mergeState?.files ?? []).filter(file => file.state === 'conflict'),
    [mergeState]
  );
  const conflictCount = conflictFiles.length;
  const resolvedCount = conflictFiles.filter(file => file.resolution !== undefined).length;
  const allResolved = mergeState?.allResolved ?? false;

  const handleResolve = useCallback(
    (path: string, resolution: MergeFileResolution): void => {
      setResolvingPath(path);
      void window.electronAPI.merge
        .resolve({ repositoryPath, path, resolution })
        .then(result => {
          if (result.success) {
            setMergeState(result.data);
          } else {
            notifyError('Resolve failed', result.error);
          }
        })
        .finally(() => setResolvingPath(null));
    },
    [repositoryPath]
  );

  const handleComplete = useCallback((): void => {
    setCompleting(true);
    setCompleteError(null);
    void window.electronAPI.merge
      .complete({ repositoryPath })
      .then(result => {
        if (result.success) {
          setLandedRevision(result.data.revision);
        } else {
          setCompleteError(result.error);
        }
      })
      .finally(() => setCompleting(false));
  }, [repositoryPath]);

  const handleAbort = useCallback((): void => {
    setAborting(true);
    void window.electronAPI.merge
      .abort({ repositoryPath })
      .then(result => {
        if (result.success) {
          setAbortConfirmOpen(false);
          window.electronAPI.window.close();
        } else {
          notifyError('Abort failed', result.error);
        }
      })
      .finally(() => setAborting(false));
  }, [repositoryPath]);

  if (startError !== null) {
    return (
      <Box p='xl'>
        <Alert color='red' variant='light' title='Could not start the merge'>
          {startError}
        </Alert>
      </Box>
    );
  }

  if (starting || mergeState === null) {
    return (
      <Center style={{ flex: 1 }}>
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      <MergeHeader
        sourceBranch={sourceBranch}
        targetBranch={targetBranch}
        repositoryName={repositoryName}
        commitCount={revisions.length}
        conflictCount={conflictCount}
      />

      <Group gap={0} align='stretch' wrap='nowrap' style={{ flex: 1, minHeight: 0 }}>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <MergeFileArea
            targetBranch={targetBranch}
            sourceBranch={sourceBranch}
            landedRevision={landedRevision}
            mergedFiles={mergedFiles}
            conflictFiles={conflictFiles}
            bothSides={bothSides}
            resolvingPath={resolvingPath}
            onResolve={handleResolve}
          />
        </Box>

        <Box w={300} style={{ minHeight: 0 }}>
          <MergeSidebar
            repositoryId={request.repositoryId}
            workspacePath={repositoryPath}
            targetBranch={targetBranch}
            revisions={revisions}
            conflictFiles={conflictFiles}
          />
        </Box>
      </Group>

      {completeError !== null && (
        <Alert mx='md' mt='sm' color='red' variant='light' title='Merge could not be completed'>
          {`${completeError} The workspace merge is intact — you can retry.`}
        </Alert>
      )}

      <MergeBar
        conflictCount={conflictCount}
        resolvedCount={resolvedCount}
        allResolved={allResolved}
        completing={completing}
        landedRevision={landedRevision}
        targetBranch={targetBranch}
        onAbort={() => setAbortConfirmOpen(true)}
        onMerge={handleComplete}
      />

      <AbortMergeModal
        opened={abortConfirmOpen}
        sourceBranch={sourceBranch}
        aborting={aborting}
        onClose={() => setAbortConfirmOpen(false)}
        onConfirm={handleAbort}
      />
    </Stack>
  );
}
