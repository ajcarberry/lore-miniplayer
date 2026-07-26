import { useCallback, useState } from 'react';
import type { Repository } from '../../shared/types';
import type { RepositoriesState } from './useRepositories';
import type { BranchesState } from './useBranches';
import { logError } from '../utils/logging';
import { notifyError } from '../utils/notify';

export interface RepositoryMutations {
  // The repository open in the edit modal, or null when it is closed.
  readonly editingRepo: Repository | null;
  readonly setEditingRepo: (repo: Repository | null) => void;
  readonly handleUpdateRepository: (updated: Repository) => Promise<void>;
  readonly handleDeleteRepository: (repo: Repository) => Promise<void>;
}

// The edit modal's update/delete flows: persist through the repository IPC,
// refresh the list, keep the selection coherent (a deleted selection falls
// back to none + main), and close the modal on success.
export function useRepositoryMutations(
  repos: RepositoriesState,
  branches: BranchesState
): RepositoryMutations {
  const [editingRepo, setEditingRepo] = useState<Repository | null>(null);

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

  return { editingRepo, setEditingRepo, handleUpdateRepository, handleDeleteRepository };
}
