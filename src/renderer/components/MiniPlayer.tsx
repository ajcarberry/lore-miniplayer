import type { CSSProperties, ReactElement } from 'react';
import { useCallback, useState } from 'react';
import { Box, Image, Paper, Stack } from '@mantine/core';
import LogomarkPath from '/Lore_Icon_White_V1.svg';
import type { LoreSyncOptions, Repository } from '../../shared/types';
import { accentStyleVars } from '../../shared/accent';
import { useServerConnection } from '../hooks/useServerConnection';
import { useRepositories } from '../hooks/useRepositories';
import { useBranches } from '../hooks/useBranches';
import { useBranchDivergence } from '../hooks/useBranchDivergence';
import { useBranchGraph } from '../hooks/useBranchGraph';
import { useRepositoryStatus } from '../hooks/useRepositoryStatus';
import { useSyncActions } from '../hooks/useSyncActions';
import { useFileStaging } from '../hooks/useFileStaging';
import { useWorkingSet } from '../hooks/useWorkingSet';
import { useExpansion } from '../hooks/useExpansion';
import { useRepositoryNotifications } from '../hooks/useRepositoryNotifications';
import { useLocalStateWatch } from '../hooks/useLocalStateWatch';
import { logError } from '../utils/logging';
import { notifyError } from '../utils/notify';
import { computeActionSignals } from '../utils/actionSignals';
import { TitleBar } from './TitleBar';
import { Pill } from './Pill';
import { ConnectPage } from './ConnectPage';
import { UtilityFooter } from './UtilityFooter';
import { SyncView } from './SyncView';
import { PlayerDialogs } from './PlayerDialogs';

// Accent vars for the collapsed pill, matching the card's scope. React's
// CSSProperties has no entry for CSS custom properties, hence the assertion.
function pillAccent(repo: Repository | null): CSSProperties | undefined {
  return repo ? (accentStyleVars(repo.accentHue) as unknown as CSSProperties) : undefined;
}

interface PlayerCardProps {
  readonly server: ReturnType<typeof useServerConnection>;
  readonly repos: ReturnType<typeof useRepositories>;
  readonly branches: ReturnType<typeof useBranches>;
  readonly status: ReturnType<typeof useRepositoryStatus>;
  readonly divergence: ReturnType<typeof useBranchDivergence>;
  readonly graph: ReturnType<typeof useBranchGraph>;
  readonly syncActions: ReturnType<typeof useSyncActions>;
  readonly fileStaging: ReturnType<typeof useFileStaging>;
  readonly workingSet: ReturnType<typeof useWorkingSet>;
  readonly isBusy: boolean;
  readonly onSyncToRevision: () => void;
  readonly onSyncToSelected: (revision: string) => void;
  readonly onReset: () => void;
  readonly onAddRepo: () => void;
  readonly onEditRepo: (repo: Repository) => void;
  readonly onCollapse: () => void;
}

// The full card surface: title bar, the connect page or sync view, and the
// utility footer. Rendered inside the morph's unfold region — visually
// collapsed to the pill until expanded (see morph.css).
function PlayerCard({
  server,
  repos,
  branches,
  status,
  divergence,
  graph,
  syncActions,
  fileStaging,
  workingSet,
  isBusy,
  onSyncToRevision,
  onSyncToSelected,
  onReset,
  onAddRepo,
  onEditRepo,
  onCollapse,
}: PlayerCardProps): ReactElement {
  const currentBranchObj = branches.branches.find(branch => branch.isCurrent);
  const needsBranchSwitch =
    currentBranchObj !== undefined && currentBranchObj.name !== branches.currentBranch;
  const showClone = status.repoStatus !== null && !status.repoStatus.isLoreRepo;

  return (
    <Paper
      radius='md'
      p={0}
      shadow='xl'
      style={{
        width: '100%',
        height: '100%',
        border: '1px solid var(--hair)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        ...(repos.selectedRepo ? accentStyleVars(repos.selectedRepo.accentHue) : {}),
      }}
    >
      <TitleBar {...(server.isConnected ? { onCollapse } : {})} />

      <Stack gap='md' p='xl' style={{ flex: 1, position: 'relative' }}>
        {/* Background logomark for connected view */}
        {server.isConnected && (
          <Box
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              opacity: 0.15,
              pointerEvents: 'none',
              zIndex: 0,
            }}
          >
            <Image src={LogomarkPath} alt='Lore' style={{ height: '64px', width: 'auto' }} />
          </Box>
        )}

        {!server.isConnected ? (
          <ConnectPage initialAddress={server.lastKnownAddress} onConnect={server.connect} />
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', height: '100%', zIndex: 1 }}>
            <Stack gap='lg' style={{ flex: 1, justifyContent: 'flex-start', paddingTop: '0px' }}>
              <SyncView
                repos={repos}
                branches={branches}
                divergence={divergence}
                graph={graph}
                syncActions={syncActions}
                fileStaging={fileStaging}
                showClone={showClone}
                isBusy={isBusy}
                needsBranchSwitch={needsBranchSwitch}
                onSyncToRevision={onSyncToRevision}
                onSyncToSelected={onSyncToSelected}
                onReset={onReset}
                onCommit={workingSet.openCommitDialog}
                workingSetFiles={workingSet.workingSetFiles}
                workingSetOpen={workingSet.workingSetOpen}
                onToggleWorkingSetOpen={workingSet.toggleWorkingSetOpen}
                onToggleFile={workingSet.toggleFile}
              />
            </Stack>
          </Box>
        )}
      </Stack>

      {server.isConnected && (
        <UtilityFooter
          selectedRepo={repos.selectedRepo}
          repositories={repos.repositories}
          isLoadingRepos={repos.isLoading}
          onSelectRepo={repos.selectRepository}
          onAddRepo={onAddRepo}
          onEditRepo={onEditRepo}
          onRefreshRepos={() => void repos.refresh()}
          serverUrl={server.serverUrl}
          onChangeServer={server.disconnect}
        />
      )}
    </Paper>
  );
}

export function MiniPlayer(): ReactElement {
  const server = useServerConnection();
  const repos = useRepositories(server.isConnected);
  const branches = useBranches(repos.selectedRepo, server.isConnected);
  const status = useRepositoryStatus(repos.selectedRepo, server.isConnected);
  const divergence = useBranchDivergence(
    repos.selectedRepo,
    branches.currentBranch,
    server.isConnected
  );
  const graph = useBranchGraph(repos.selectedRepo, branches.currentBranch, server.isConnected);
  // Server push notifications replace polling: any push refreshes divergence
  // and the graph; branch create/delete additionally reloads the branch list.
  useRepositoryNotifications(repos.selectedRepo, server.isConnected, kind => {
    void divergence.refresh();
    void graph.refresh();
    if (kind !== 'branchPushed') {
      void branches.refresh();
    }
  });
  // Catch-all for mutations made outside the app (CLI commit/sync/switch),
  // which the server never announces; a branch switch also means the branch
  // list must reload.
  useLocalStateWatch(repos.selectedRepo, server.isConnected, () => {
    void divergence.refresh();
    void graph.refresh();
    void branches.refresh();
  });
  const fileStaging = useFileStaging(repos.selectedRepo);
  const syncActions = useSyncActions({
    selectedRepo: repos.selectedRepo,
    branches: branches.branches,
    targetBranch: branches.currentBranch,
    refreshBranches: branches.refresh,
    refreshStatus: status.refresh,
    refreshDivergence: divergence.refresh,
    refreshGraph: graph.refresh,
  });

  const [addRepoModalOpened, setAddRepoModalOpened] = useState(false);
  const [editingRepo, setEditingRepo] = useState<Repository | null>(null);
  const [revisionSyncModalOpened, setRevisionSyncModalOpened] = useState(false);
  const [revisionSyncPrefill, setRevisionSyncPrefill] = useState('');
  const [resetConfirmModalOpened, setResetConfirmModalOpened] = useState(false);
  const workingSet = useWorkingSet(fileStaging, () => {
    void divergence.refresh();
    void graph.refresh();
  });

  // Open the sync-to-revision modal blank (from the transport menu) or
  // prefilled with a chosen revision hash (from the history section).
  const openRevisionSync = useCallback((prefill: string): void => {
    setRevisionSyncPrefill(prefill);
    setRevisionSyncModalOpened(true);
  }, []);

  const handleAddRepository = useCallback(
    (newRepo: Repository): void => {
      void repos.refresh();
      repos.selectRepository(newRepo);
      branches.setCurrentBranch('main');
    },
    [repos, branches]
  );

  const handleUpdateRepository = useCallback(
    async (updated: Repository): Promise<void> => {
      const result = await window.electronAPI.repository.update({
        id: updated.id,
        name: updated.name,
        accentHue: updated.accentHue,
      });
      if (!result.success) {
        logError('Failed to update repository', {
          error: result.error,
          updated,
          operation: 'MiniPlayer',
        });
        notifyError('Update Repository Failed', result.error);
        return;
      }
      void repos.refresh();
      if (repos.selectedRepo?.id === updated.id) {
        repos.selectRepository(updated);
      }
      setEditingRepo(null);
    },
    [repos]
  );

  const handleDeleteRepository = useCallback(
    async (repo: Repository): Promise<void> => {
      const result = await window.electronAPI.repository.delete(repo.id);
      if (!result.success) {
        logError('Failed to delete repository', {
          error: result.error,
          repo,
          operation: 'MiniPlayer',
        });
        notifyError('Delete Repository Failed', result.error);
        return;
      }
      void repos.refresh();
      if (repos.selectedRepo?.id === repo.id) {
        repos.selectRepository(null);
        branches.setCurrentBranch('main');
      }
      setEditingRepo(null);
    },
    [repos, branches]
  );

  const handleSyncWithOptions = useCallback(
    async (options: LoreSyncOptions): Promise<void> => {
      if (await syncActions.syncWithOptions(options)) {
        setRevisionSyncModalOpened(false);
      }
    },
    [syncActions]
  );

  const handleReset = useCallback(async (): Promise<void> => {
    if (await syncActions.reset()) {
      setResetConfirmModalOpened(false);
    }
  }, [syncActions]);

  const isBusy = syncActions.isCloning || syncActions.isSyncing || status.isChecking;
  const morph = useExpansion({ isConnected: server.isConnected });

  return (
    <div className='morph-shell'>
      <div
        className='morph-root'
        data-expanded={morph.isExpanded ? 'true' : 'false'}
        data-anchor={morph.anchor}
      >
        <div className='morph-card'>
          <div className='morph-card-inner'>
            <PlayerCard
              server={server}
              repos={repos}
              branches={branches}
              status={status}
              divergence={divergence}
              graph={graph}
              syncActions={syncActions}
              fileStaging={fileStaging}
              workingSet={workingSet}
              isBusy={isBusy}
              onSyncToRevision={() => openRevisionSync('')}
              onSyncToSelected={revision => openRevisionSync(revision)}
              onReset={() => setResetConfirmModalOpened(true)}
              onAddRepo={() => setAddRepoModalOpened(true)}
              onEditRepo={setEditingRepo}
              onCollapse={morph.forceCollapse}
            />
          </div>
        </div>

        {server.isConnected && (
          <div
            className='morph-pill'
            style={pillAccent(repos.selectedRepo)}
            onPointerDown={morph.onPillPointerDown}
            onPointerMove={morph.onPillPointerMove}
            onPointerUp={morph.onPillPointerUp}
          >
            <Pill
              repository={repos.selectedRepo}
              branchName={branches.currentBranch}
              signals={computeActionSignals({
                divergenceState: divergence.divergence?.state,
                currentRevision: graph.graph.current,
                branchTipRevision: graph.graph.branch.revisions[0]?.revision ?? '',
                dirtyCount:
                  fileStaging.transferListData[0].length + fileStaging.transferListData[1].length,
              })}
              onClose={() => window.electronAPI.window.close()}
            />
          </div>
        )}
      </div>

      <PlayerDialogs
        server={server}
        branches={branches}
        syncActions={syncActions}
        fileStaging={fileStaging}
        workingSet={workingSet}
        addRepoModalOpened={addRepoModalOpened}
        onCloseAddRepo={() => setAddRepoModalOpened(false)}
        onAddRepository={handleAddRepository}
        editingRepo={editingRepo}
        onCloseEdit={() => setEditingRepo(null)}
        onSaveEdit={repo => void handleUpdateRepository(repo)}
        onDeleteEdit={repo => void handleDeleteRepository(repo)}
        revisionSyncModalOpened={revisionSyncModalOpened}
        revisionSyncPrefill={revisionSyncPrefill}
        onCloseRevisionSync={() => setRevisionSyncModalOpened(false)}
        onSyncWithOptions={options => void handleSyncWithOptions(options)}
        resetConfirmModalOpened={resetConfirmModalOpened}
        onCloseReset={() => setResetConfirmModalOpened(false)}
        onConfirmReset={() => void handleReset()}
      />
    </div>
  );
}
