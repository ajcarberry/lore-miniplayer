import type { ReactElement } from 'react';
import { useCallback, useState } from 'react';
import type { BranchDivergence, RevisionSummary } from '../../shared/types';
import { isWorkspaceBehindTip } from '../utils/actionSignals';
import type { RepositoriesState } from '../hooks/useRepositories';
import type { BranchesState } from '../hooks/useBranches';
import type { BranchDivergenceState } from '../hooks/useBranchDivergence';
import type { BranchGraphState } from '../hooks/useBranchGraph';
import type { SyncActionsState } from '../hooks/useSyncActions';
import type { FileStagingState } from '../hooks/useFileStaging';
import { WorkingSet } from './WorkingSet';
import type { WorkingSetFile, WorkingSetProps } from './WorkingSet';
import { buildReviewOpenRequest } from './review/openReview';
import { useRevisionsToLand } from '../hooks/useRevisionsToLand';
import type {
  LoreBranch,
  Repository,
  ReviewOpenRequest,
  ReviewWorkflowMode,
} from '../../shared/types';
import { HistorySection } from './HistorySection';
import { PlayerHeader } from './PlayerHeader';
import { BranchSwitcher } from './BranchSwitcher';
import { Transport } from './Transport';
import type { TransportProps } from './Transport';

// Maps branch divergence to the Sync cell's sub-caption (when a branch
// switch isn't also pending — that case wins in buildTransportProps).
function syncSub(state: BranchDivergence['state'] | undefined, onOlderRevision: boolean): string {
  if (state === 'behindOrDiverged') {
    return 'Behind remote';
  }
  return onOlderRevision ? 'Older revision' : 'Current';
}

// Maps branch divergence to the Push cell's sub-caption.
function pushSub(state: BranchDivergence['state'] | undefined): string {
  if (state === 'inSync') {
    return 'Up to date';
  }
  if (state === 'ahead') {
    return 'To push';
  }
  return '—';
}

export interface TransportInputs {
  readonly hasSelection: boolean;
  readonly showClone: boolean;
  readonly isBusy: boolean;
  readonly needsBranchSwitch: boolean;
  readonly isSyncing: boolean;
  readonly isCloning: boolean;
  readonly isCommitting: boolean;
  readonly isPushing: boolean;
  readonly stagedCount: number;
  readonly divergenceState: BranchDivergence['state'] | undefined;
  readonly currentRevision: string;
  readonly branchTipRevision: string;
  readonly onSync: () => void;
  readonly onCommit: () => void;
  readonly onPush: () => void;
  readonly onClone: () => void;
  readonly onSyncToRevision: () => void;
  readonly onReset: () => void;
}

// Pure branching logic for the Transport props, kept out of the component
// bodies to stay under the cyclomatic-complexity limit.
export function buildTransportProps(inputs: TransportInputs): TransportProps {
  const {
    hasSelection,
    showClone,
    isBusy,
    needsBranchSwitch,
    isSyncing,
    isCloning,
    isCommitting,
    isPushing,
    stagedCount,
    divergenceState,
    currentRevision,
    branchTipRevision,
    onSync,
    onCommit,
    onPush,
    onClone,
    onSyncToRevision,
    onReset,
  } = inputs;

  const onOlderRevision = isWorkspaceBehindTip(currentRevision, branchTipRevision);

  return {
    mode: showClone ? 'clone' : 'normal',
    sync: {
      label: 'Sync',
      sub: needsBranchSwitch ? 'Switch & sync' : syncSub(divergenceState, onOlderRevision),
      busy: isSyncing,
      disabled: !hasSelection || isBusy || showClone,
      accented: divergenceState === 'behindOrDiverged' || onOlderRevision,
      onClick: onSync,
      menu: { onSyncToRevision, onReset },
    },
    commit: {
      count: stagedCount,
      disabled: !hasSelection || showClone || isBusy,
      busy: isCommitting,
      accented: stagedCount > 0,
      onClick: onCommit,
    },
    push: {
      sub: pushSub(divergenceState),
      disabled: !hasSelection || showClone || isBusy,
      busy: isPushing,
      accented: divergenceState === 'ahead',
      onClick: onPush,
    },
    clone: {
      busy: isCloning,
      onClick: onClone,
    },
  };
}

// The merge workflow's landing target: the branch's parent lane when the
// graph resolves one, else the server's default branch, else 'main'.
export function resolveMergeTarget(
  parentLaneName: string | undefined,
  branches: LoreBranch[]
): string {
  return parentLaneName ?? branches.find(branch => branch.isDefault)?.name ?? 'main';
}

export interface ReviewEntryInputs {
  readonly selectedRepo: Repository | null;
  readonly showClone: boolean;
  readonly branchName: string;
  readonly currentRevision: string;
  readonly mergeTarget: string;
  // Dirty (working-set) file count: with nothing dirty there is nothing to
  // review, so the Review entry is withheld.
  readonly dirtyFileCount: number;
  // The merge service's ancestry predicate (useRevisionsToLand): Merge is
  // offered only when the branch really carries revisions the target lacks —
  // never a merge that would land nothing.
  readonly hasRevisionsToLand: boolean;
  // Receives the built open request — the card morphs into the Project View.
  readonly openProjectView: (request: ReviewOpenRequest) => void;
}

// The WorkingSet header's Review/Merge entry props. Each entry appears only
// with a reason to: Review when the working set has dirty files, Merge when
// the target is a different branch AND the branch is ahead of it. Kept out of
// the component body (complexity limit), like buildTransportProps.
export function buildReviewEntryProps(
  inputs: ReviewEntryInputs
): Pick<WorkingSetProps, 'onReview' | 'onMerge'> {
  const { selectedRepo, showClone, branchName, currentRevision, mergeTarget } = inputs;
  if (selectedRepo === null || showClone) {
    return {};
  }
  const open = (workflow: ReviewWorkflowMode): void =>
    inputs.openProjectView(
      buildReviewOpenRequest({
        repository: selectedRepo,
        branchName,
        currentRevision,
        targetBranch: mergeTarget,
        workflow,
      })
    );
  return {
    ...(inputs.dirtyFileCount > 0 ? { onReview: () => open('commit') } : {}),
    ...(mergeTarget !== branchName && inputs.hasRevisionsToLand
      ? { onMerge: () => open('merge') }
      : {}),
  };
}

// A content signature for the revisions list. useBranchGraph returns a fresh
// empty graph on every render while loading/disconnected, so comparing by
// array reference would reset (and re-render) on every render; comparing by
// content lets two empty lists compare equal.
function revisionsKey(revisions: RevisionSummary[]): string {
  return revisions.map(revision => revision.revision).join('|');
}

// Selected revision index resets to 0 (newest) whenever the revisions list's
// content changes (repo/branch switch, refresh). Adjusted during render per
// the react.dev "You Might Not Need an Effect" prev-tracking pattern, to
// avoid a synchronous setState-in-effect.
function useSelectedRevisionIndex(revisions: RevisionSummary[]): [number, (index: number) => void] {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const key = revisionsKey(revisions);
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setSelectedIndex(0);
  }
  return [selectedIndex, setSelectedIndex];
}

export interface SyncViewProps {
  readonly repos: RepositoriesState;
  readonly branches: BranchesState;
  readonly divergence: BranchDivergenceState;
  readonly graph: BranchGraphState;
  readonly syncActions: SyncActionsState;
  readonly fileStaging: FileStagingState;
  readonly showClone: boolean;
  readonly isBusy: boolean;
  readonly needsBranchSwitch: boolean;
  readonly onSyncToRevision: () => void;
  readonly onSyncToSelected: (revision: string) => void;
  readonly onReset: () => void;
  readonly onCommit: () => void;
  readonly workingSetFiles: WorkingSetFile[];
  readonly workingSetOpen: boolean;
  readonly onToggleWorkingSetOpen: () => void;
  readonly onToggleFile: (path: string) => void;
  // Receives the built open request — the card morphs into the Project View.
  readonly onOpenProjectView: (request: ReviewOpenRequest) => void;
}

// The sync view: repository picker, the branch-switcher-anchored header, and
// the transport row (Sync / Commit / Push, or Clone when not on disk yet),
// with the collapsible working-set file list and history section underneath.
export function SyncView({
  repos,
  branches,
  divergence,
  graph,
  syncActions,
  fileStaging,
  showClone,
  isBusy,
  needsBranchSwitch,
  onSyncToRevision,
  onSyncToSelected,
  onReset,
  onCommit,
  workingSetFiles,
  workingSetOpen,
  onToggleWorkingSetOpen,
  onToggleFile,
  onOpenProjectView,
}: SyncViewProps): ReactElement {
  const branchGraph = graph.graph;
  const revisions = branchGraph.branch.revisions;
  const [selectedRevisionIndex, setSelectedRevisionIndex] = useSelectedRevisionIndex(revisions);
  const mergeTarget = resolveMergeTarget(branchGraph.parent?.name, branches.branches);
  // SyncView is only mounted while connected, so the hook's flag is constant.
  const revisionsToLand = useRevisionsToLand(
    repos.selectedRepo,
    branches.currentBranch,
    mergeTarget,
    true,
    revisions[0]?.revision ?? ''
  );
  const reviewEntry = buildReviewEntryProps({
    selectedRepo: repos.selectedRepo,
    showClone,
    branchName: branches.currentBranch,
    currentRevision: branchGraph.current,
    mergeTarget,
    dirtyFileCount: workingSetFiles.length,
    hasRevisionsToLand: revisionsToLand.hasRevisionsToLand,
    openProjectView: onOpenProjectView,
  });
  // Push refreshes branch divergence on success — it typically flips from
  // "out of sync" to "up to date".
  const handlePush = useCallback(async (): Promise<void> => {
    if (await fileStaging.push()) {
      await divergence.refresh();
    }
  }, [fileStaging, divergence]);

  const transportProps = buildTransportProps({
    hasSelection: repos.selectedRepo !== null,
    showClone,
    isBusy,
    needsBranchSwitch,
    isSyncing: syncActions.isSyncing,
    isCloning: syncActions.isCloning,
    isCommitting: fileStaging.isCommitting,
    isPushing: fileStaging.isPushing,
    stagedCount: fileStaging.transferListData[1].length,
    divergenceState: divergence.divergence?.state,
    currentRevision: branchGraph.current,
    branchTipRevision: revisions[0]?.revision ?? '',
    onSync: () => void syncActions.sync(),
    onCommit,
    onPush: () => void handlePush(),
    onClone: () => void syncActions.clone(),
    onSyncToRevision,
    onReset,
  });

  return (
    <>
      <BranchSwitcher
        branches={branches.branches}
        currentBranch={branches.currentBranch}
        isLoading={branches.isLoading}
        onSelect={branches.setCurrentBranch}
        onReload={() => void branches.refresh()}
      >
        {onOpenSwitcher => (
          <PlayerHeader
            repository={repos.selectedRepo}
            branchName={branches.currentBranch}
            onOpenSwitcher={onOpenSwitcher}
          />
        )}
      </BranchSwitcher>
      <Transport {...transportProps} />
      <WorkingSet
        files={workingSetFiles}
        open={workingSetOpen}
        onToggleOpen={onToggleWorkingSetOpen}
        onToggleFile={onToggleFile}
        isLoading={fileStaging.isLoadingFiles}
        conflictRevisionNumber={revisions[0]?.revisionNumber}
        {...reviewEntry}
      />
      {!showClone && (
        <HistorySection
          branchName={branchGraph.branch.name || branches.currentBranch}
          revisions={revisions}
          current={branchGraph.current}
          {...(branchGraph.parent ? { parent: branchGraph.parent } : {})}
          mergesFromParent={branchGraph.mergesFromParent}
          mergesToParent={branchGraph.mergesToParent}
          isLoading={graph.isLoading}
          selectedIndex={selectedRevisionIndex}
          onSelect={setSelectedRevisionIndex}
          onSyncToSelected={onSyncToSelected}
        />
      )}
    </>
  );
}
