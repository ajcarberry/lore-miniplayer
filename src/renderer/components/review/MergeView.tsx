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
import { ownCommits } from '../laneLayout';
import { IconGitMerge } from '@tabler/icons-react';
import { pluralize } from '../../utils/pluralize';
import { AbortMergeModal } from './AbortMergeModal';
import { MergeBar } from './MergeBar';
import { MergeFileArea } from './MergeFileArea';
import { MergeSidebar } from './MergeSidebar';
import { TitleBar } from '../TitleBar';
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

type LeaveDestination = 'card' | 'commit' | 'pill';

export interface MergeViewProps {
  readonly request: ReviewOpenRequest;
  // Morph back to the card.
  readonly onExit: () => void;
  // Collapse straight to the ambient pill.
  readonly onCollapse: () => void;
  // Re-open the view with the other workflow (the header switcher).
  readonly onSwitchWorkflow: (workflow: ReviewWorkflowMode) => void;
}

interface MergeLeaveDeps {
  readonly repositoryPath: string;
  readonly live: boolean;
  readonly onExit: () => void;
  readonly onCollapse: () => void;
  readonly onSwitchWorkflow: (workflow: ReviewWorkflowMode) => void;
}

// Every way out of a live merge (Back, TitleBar collapse, the workflow
// switcher, Abort) routes through one discard confirmation — the on-disk
// merge would otherwise be stranded with no surface able to finish it. A
// landed merge, a merge that never started, or a start error leaves directly.
function useMergeLeave(deps: MergeLeaveDeps): {
  abortConfirmOpen: boolean;
  closeAbortConfirm: () => void;
  aborting: boolean;
  handleAbort: () => void;
  leaveMerge: (to: LeaveDestination) => void;
  openAbortConfirm: () => void;
} {
  const { repositoryPath, live, onExit, onCollapse, onSwitchWorkflow } = deps;
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false);
  const [aborting, setAborting] = useState(false);
  // Where a confirmed discard goes.
  const [leaveTo, setLeaveTo] = useState<LeaveDestination>('card');
  const leaveNow = useCallback(
    (to: LeaveDestination): void => {
      if (to === 'commit') {
        onSwitchWorkflow('commit');
      } else if (to === 'pill') {
        onCollapse();
      } else {
        onExit();
      }
    },
    [onSwitchWorkflow, onCollapse, onExit]
  );

  const handleAbort = useCallback((): void => {
    setAborting(true);
    void window.electronAPI.merge
      .abort({ repositoryPath })
      .then(result => {
        if (result.success) {
          setAbortConfirmOpen(false);
          leaveNow(leaveTo);
        } else {
          notifyError('Abort failed', result.error);
        }
      })
      .finally(() => setAborting(false));
  }, [repositoryPath, leaveTo, leaveNow]);

  const leaveMerge = useCallback(
    (to: LeaveDestination): void => {
      if (live) {
        setLeaveTo(to);
        setAbortConfirmOpen(true);
        return;
      }
      leaveNow(to);
    },
    [live, leaveNow]
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

interface MergeStart {
  readonly mergeState: MergeState | null;
  readonly setMergeState: (state: MergeState) => void;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly bothSides: Map<string, FileDiffResult>;
}

// Starts the merge once on mount (the view remounts per request, so `starting`
// begins true), then fetches both sides of every conflicted file — MergeState
// carries paths only, no content. Every write happens inside a resolved
// promise and is dropped once cancelled. A failure to load the sides is
// notified rather than fatal: the merge itself is live by then.
function useMergeStart(
  repositoryPath: string,
  sourceBranch: string,
  targetBranch: string
): MergeStart {
  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [starting, setStarting] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [bothSides, setBothSides] = useState<Map<string, FileDiffResult>>(new Map());

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
          return;
        }
        setMergeState(result.data);
        const conflictPaths = result.data.files
          .filter(file => file.state === 'conflict')
          .map(file => file.path);
        if (conflictPaths.length === 0) {
          return;
        }
        try {
          // Theirs = the target revision the merge actually brought in, on the
          // diff's source side; mine = source head (branch) on the target side,
          // so removed lines are theirs and added lines are mine. The target
          // side is addressed by REVISION, not by branch head: the merge's
          // content is frozen at the revision branchMergeStart streamed, while
          // the target's tip can advance underneath the open merge.
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
        } catch (error) {
          notifyError('Could not load conflict contents', String(error));
        }
      })
      .catch((error: unknown) => {
        // The bridge itself rejected; without this the view would hold its
        // loader forever with no way to reach the merge or clear it.
        if (!cancelled) {
          setStartError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStarting(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [repositoryPath, sourceBranch, targetBranch]);

  return { mergeState, setMergeState, starting, startError, bothSides };
}

// The Project View's merge workflow. Truthful semantics: the merge runs IN
// the checkout (mine = the source branch, theirs = the target branch);
// resolution is per FILE; and completion lands the merge revision on the
// TARGET branch and pushes it. On mount it starts the merge through the merge
// bridge, fetches both sides of each conflicted file via the diff bridge
// (MergeState carries no content), and drives resolve / abort / complete.
// Errors from start and complete surface as Mantine alerts, never silently.
export function MergeView(props: MergeViewProps): ReactElement {
  const { request, onExit, onCollapse, onSwitchWorkflow } = props;
  const repositoryPath = request.repositoryPath;
  const sourceBranch = request.branchName;
  const targetBranch = request.targetBranch;

  const { mergeState, setMergeState, starting, startError, bothSides } = useMergeStart(
    repositoryPath,
    sourceBranch,
    targetBranch
  );
  const { revisions, parentBranchPoint } = useReviewMeta(repositoryPath, sourceBranch);
  // Only the branch's OWN commits land — see ownCommits.
  const aheadRevisions = useMemo(
    () => ownCommits(revisions, parentBranchPoint),
    [revisions, parentBranchPoint]
  );
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [landedRevision, setLandedRevision] = useState<string | null>(null);
  const leave = useMergeLeave({
    repositoryPath,
    live: mergeState !== null && landedRevision === null,
    onExit,
    onCollapse,
    onSwitchWorkflow,
  });

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
    [repositoryPath, setMergeState]
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

  const titleBar = <TitleBar onCollapse={() => leave.leaveMerge('pill')} />;

  if (startError !== null) {
    return (
      <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
        {titleBar}
        <MergeStartError
          error={startError}
          aborting={leave.aborting}
          onAbort={leave.handleAbort}
          onExit={onExit}
        />
      </Stack>
    );
  }

  if (starting || mergeState === null) {
    return (
      <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
        {titleBar}
        <Center style={{ flex: 1 }}>
          <Loader />
        </Center>
      </Stack>
    );
  }

  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      {titleBar}
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
        eyebrow={`${request.repositoryName} · ${aheadRevisions.length} ${pluralize(aheadRevisions.length, 'commit')} · ${conflictCount} ${pluralize(conflictCount, 'conflict')}`}
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
            revisions={aheadRevisions}
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
