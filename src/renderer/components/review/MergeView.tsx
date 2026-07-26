import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Center, Group, Loader, Stack } from '@mantine/core';
import type {
  ReviewWorkflowMode,
  FileDiffResult,
  MergeFileResolution,
  MergeState,
  ReviewOpenRequest,
} from '../../../shared/types';
import { notifyError } from '../../utils/notify';
import { IconGitMerge } from '@tabler/icons-react';
import { pluralize } from '../../utils/pluralize';
import { AbortMergeModal } from './AbortMergeModal';
import { MergeBar } from './MergeBar';
import { MergeFileArea } from './MergeFileArea';
import { MergeSidebar } from './MergeSidebar';
import { ReviewHeader } from './ReviewHeader';
import { WorkflowSwitch } from './WorkflowSwitch';
import { useReviewMeta } from './useReviewMeta';

interface MergeStartErrorProps {
  readonly error: string;
  readonly aborting: boolean;
  readonly onAbort: () => void;
  readonly onExit: () => void;
}

// The start-failure state. The usual cause is a merge stranded by an earlier
// session, which only an abort can clear — so it carries one, plus a Back
// escape to the card.
function MergeStartError(props: MergeStartErrorProps): ReactElement {
  return (
    <Box p='xl'>
      <Alert color='red' variant='light' title='Could not start the merge'>
        <Stack gap='sm' align='flex-start'>
          {props.error}
          <Group gap='sm'>
            <Button color='red' variant='light' loading={props.aborting} onClick={props.onAbort}>
              Abort merge
            </Button>
            <Button variant='subtle' onClick={props.onExit}>
              Back
            </Button>
          </Group>
        </Stack>
      </Alert>
    </Box>
  );
}

export interface MergeViewProps {
  readonly request: ReviewOpenRequest;
  // Morph back to the card.
  readonly onExit: () => void;
  // Re-open the view with the other workflow (the header switcher).
  readonly onSwitchWorkflow: (workflow: ReviewWorkflowMode) => void;
}

// The Project View's merge workflow. Truthful semantics: the merge
// runs IN the checkout (mine = the source branch, theirs =
// the target branch, main); resolution is per FILE; and completion lands the
// merge revision on the TARGET branch and pushes it. On mount it starts the
// merge through the merge bridge, fetches both sides of each conflicted file via
// the diff bridge (MergeState carries no content), and drives resolve /
// abort / complete. Errors from start and complete surface as Mantine alerts,
// never silently.
interface MergeLeaveDeps {
  readonly repositoryPath: string;
  readonly live: boolean;
  readonly onExit: () => void;
  readonly onSwitchWorkflow: (workflow: ReviewWorkflowMode) => void;
}

// Every way out of a live merge (Back, the workflow switcher, Abort) routes
// through one discard confirmation — the on-disk merge would otherwise be
// stranded with no surface able to finish it. A landed merge, a merge that
// never started, or a start error leaves directly.
function useMergeLeave(deps: MergeLeaveDeps): {
  abortConfirmOpen: boolean;
  closeAbortConfirm: () => void;
  aborting: boolean;
  handleAbort: () => void;
  leaveMerge: (to: 'card' | 'commit') => void;
  openAbortConfirm: () => void;
} {
  const { repositoryPath, live, onExit, onSwitchWorkflow } = deps;
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false);
  const [aborting, setAborting] = useState(false);
  // Where a confirmed discard goes: the card or the commit view.
  const [leaveTo, setLeaveTo] = useState<'card' | 'commit'>('card');

  const handleAbort = useCallback((): void => {
    setAborting(true);
    void window.electronAPI.merge
      .abort({ repositoryPath })
      .then(result => {
        if (result.success) {
          setAbortConfirmOpen(false);
          if (leaveTo === 'commit') {
            onSwitchWorkflow('commit');
          } else {
            onExit();
          }
        } else {
          notifyError('Abort failed', result.error);
        }
      })
      .finally(() => setAborting(false));
  }, [repositoryPath, leaveTo, onSwitchWorkflow, onExit]);

  const leaveMerge = useCallback(
    (to: 'card' | 'commit'): void => {
      if (live) {
        setLeaveTo(to);
        setAbortConfirmOpen(true);
        return;
      }
      if (to === 'commit') {
        onSwitchWorkflow('commit');
      } else {
        onExit();
      }
    },
    [live, onSwitchWorkflow, onExit]
  );

  const openAbortConfirm = useCallback((): void => {
    setLeaveTo('card');
    setAbortConfirmOpen(true);
  }, []);

  return {
    abortConfirmOpen,
    closeAbortConfirm: () => setAbortConfirmOpen(false),
    aborting,
    handleAbort,
    leaveMerge,
    openAbortConfirm,
  };
}

export function MergeView(props: MergeViewProps): ReactElement {
  const { request, onExit, onSwitchWorkflow } = props;
  const repositoryPath = request.repositoryPath;
  const sourceBranch = request.branchName;
  const targetBranch =
    request.compare.target.kind === 'branchHead' ? request.compare.target.branch : 'main';

  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [starting, setStarting] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [bothSides, setBothSides] = useState<Map<string, FileDiffResult>>(new Map());
  const { repositoryName, revisions } = useReviewMeta(
    repositoryPath,
    request.repositoryId,
    sourceBranch
  );
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [landedRevision, setLandedRevision] = useState<string | null>(null);
  const leave = useMergeLeave({
    repositoryPath,
    live: mergeState !== null && landedRevision === null,
    onExit,
    onSwitchWorkflow,
  });

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
          // Theirs = the target revision the merge actually brought in, on the
          // diff's source side; mine = source head (branch) on the target side,
          // so removed lines are theirs and added lines are mine. The target
          // side is addressed by REVISION, not by branch head: a `branchHead`
          // target resolves the LOCAL store's tip of main, which lags what
          // another client pushed — and the merge merged the remote. Diffing the
          // branch head would show the pre-merge base content as "theirs".
          const diffResult = await window.electronAPI.diff.compare({
            repositoryPath,
            source: { kind: 'revision', revision: result.data.targetRevision },
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

  const mergedFiles = useMemo(
    () => (mergeState?.files ?? []).filter(file => file.state === 'merged'),
    [mergeState]
  );
  const conflictFiles = useMemo(
    () => (mergeState?.files ?? []).filter(file => file.state === 'conflict'),
    [mergeState]
  );
  const conflictCount = conflictFiles.length;
  const hasChangesToLand = mergeState?.hasChangesToLand ?? false;

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

  const handleBack = useCallback((): void => leave.leaveMerge('card'), [leave]);

  if (startError !== null) {
    return (
      <MergeStartError
        error={startError}
        aborting={leave.aborting}
        onAbort={leave.handleAbort}
        onExit={onExit}
      />
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
      {/* Merge header: "Merge — <branch> → <target>" with a
          "<repo> · N commits · M conflicts" eyebrow, on the shared shell. */}
      <ReviewHeader
        onBack={handleBack}
        right={
          <WorkflowSwitch
            workflow='merge'
            mergeEnabled
            onSwitch={() => leave.leaveMerge('commit')}
          />
        }
        title={`Merge — ${sourceBranch} → ${targetBranch}`}
        eyebrow={`${repositoryName ? `${repositoryName} · ` : ''}${revisions.length} ${pluralize(revisions.length, 'commit')} · ${conflictCount} ${pluralize(conflictCount, 'conflict')}`}
        icon={<IconGitMerge size={18} color='var(--acc-deep, #7a5b1e)' />}
      />

      <Group gap={0} align='stretch' wrap='nowrap' style={{ flex: 1, minHeight: 0 }}>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <MergeFileArea
            targetBranch={targetBranch}
            sourceBranch={sourceBranch}
            landedRevision={landedRevision}
            hasChangesToLand={hasChangesToLand}
            mergedFiles={mergedFiles}
            conflictFiles={conflictFiles}
            bothSides={bothSides}
            resolvingPath={resolvingPath}
            onResolve={handleResolve}
          />
        </Box>

        <Box w={300} style={{ minHeight: 0 }}>
          <MergeSidebar
            targetBranch={targetBranch}
            revisions={revisions}
            conflictFiles={conflictFiles}
          />
        </Box>
      </Group>

      {completeError !== null && (
        <Alert mx='md' mt='sm' color='red' variant='light' title='Merge could not be completed'>
          {`${completeError} The merge is intact — you can retry.`}
        </Alert>
      )}

      <MergeBar
        conflictCount={conflictCount}
        resolvedCount={conflictFiles.filter(file => file.resolution !== undefined).length}
        allResolved={mergeState.allResolved}
        hasChangesToLand={hasChangesToLand}
        completing={completing}
        landedRevision={landedRevision}
        targetBranch={targetBranch}
        onAbort={leave.openAbortConfirm}
        onMerge={handleComplete}
      />

      <AbortMergeModal
        opened={leave.abortConfirmOpen}
        sourceBranch={sourceBranch}
        aborting={leave.aborting}
        onClose={leave.closeAbortConfirm}
        onConfirm={leave.handleAbort}
      />
    </Stack>
  );
}
