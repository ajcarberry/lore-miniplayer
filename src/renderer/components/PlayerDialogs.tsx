import type { ReactElement } from 'react';
import type { LoreSyncOptions, Repository } from '../../shared/types';
import type { useServerConnection } from '../hooks/useServerConnection';
import type { useBranches } from '../hooks/useBranches';
import type { useSyncActions } from '../hooks/useSyncActions';
import type { useFileStaging } from '../hooks/useFileStaging';
import type { useWorkingSet } from '../hooks/useWorkingSet';
import { CommitDialog } from './CommitDialog';
import { AddRepositoryModal } from './AddRepositoryModal';
import { EditRepositoryModal } from './EditRepositoryModal';
import { RevisionSyncModal } from './RevisionSyncModal';
import { ResetConfirmModal } from './ResetConfirmModal';

interface PlayerDialogsProps {
  readonly server: ReturnType<typeof useServerConnection>;
  readonly branches: ReturnType<typeof useBranches>;
  readonly syncActions: ReturnType<typeof useSyncActions>;
  readonly fileStaging: ReturnType<typeof useFileStaging>;
  readonly workingSet: ReturnType<typeof useWorkingSet>;
  readonly addRepoModalOpened: boolean;
  readonly onCloseAddRepo: () => void;
  readonly onAddRepository: (repo: Repository) => void;
  readonly editingRepo: Repository | null;
  readonly onCloseEdit: () => void;
  readonly onSaveEdit: (repo: Repository) => void;
  readonly onDeleteEdit: (repo: Repository) => void;
  readonly revisionSyncModalOpened: boolean;
  readonly revisionSyncPrefill: string;
  readonly onCloseRevisionSync: () => void;
  readonly onSyncWithOptions: (options: LoreSyncOptions) => void;
  readonly resetConfirmModalOpened: boolean;
  readonly onCloseReset: () => void;
  readonly onConfirmReset: () => void;
}

// The in-place dialogs (commit, add/edit repository, sync-to-revision, reset).
// All portal to the document body; they open over the expanded card.
export function PlayerDialogs({
  server,
  branches,
  syncActions,
  fileStaging,
  workingSet,
  addRepoModalOpened,
  onCloseAddRepo,
  onAddRepository,
  editingRepo,
  onCloseEdit,
  onSaveEdit,
  onDeleteEdit,
  revisionSyncModalOpened,
  revisionSyncPrefill,
  onCloseRevisionSync,
  onSyncWithOptions,
  resetConfirmModalOpened,
  onCloseReset,
  onConfirmReset,
}: PlayerDialogsProps): ReactElement {
  const currentBranchObj = branches.branches.find(branch => branch.isCurrent);

  return (
    <>
      <CommitDialog
        opened={workingSet.commitDialogOpened}
        branchName={branches.currentBranch || 'main'}
        stagedCount={fileStaging.transferListData[1].length}
        message={fileStaging.commitMessage}
        onMessageChange={fileStaging.setCommitMessage}
        onCancel={workingSet.closeCommitDialog}
        onSubmit={() => void workingSet.submitCommit()}
        isCommitting={fileStaging.isCommitting}
      />

      <AddRepositoryModal
        serverUrl={server.serverUrl ?? ''}
        opened={addRepoModalOpened}
        onClose={onCloseAddRepo}
        onAdd={onAddRepository}
      />

      <EditRepositoryModal
        opened={editingRepo !== null}
        onClose={onCloseEdit}
        onSave={onSaveEdit}
        onDelete={onDeleteEdit}
        repository={editingRepo}
      />

      <RevisionSyncModal
        opened={revisionSyncModalOpened}
        initialRevision={revisionSyncPrefill}
        onClose={onCloseRevisionSync}
        onSync={onSyncWithOptions}
        currentBranch={currentBranchObj?.name ?? ''}
        isLoading={syncActions.isSyncing}
      />

      <ResetConfirmModal
        opened={resetConfirmModalOpened}
        isResetting={syncActions.isSyncing}
        onClose={onCloseReset}
        onConfirm={onConfirmReset}
      />
    </>
  );
}
