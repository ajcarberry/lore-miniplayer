import { useCallback } from 'react';
import type { BranchDivergence, Repository } from '../../shared/types';
import { useRepoScopedQuery } from './useRepoScopedQuery';

export interface BranchDivergenceState {
  readonly divergence: BranchDivergence | null;
  readonly isLoading: boolean;
  readonly refresh: () => Promise<void>;
}

// Loads branch divergence whenever the selected repository or current branch
// changes; see useRepoScopedQuery for the identity-derived loading and
// stale-response semantics.
export function useBranchDivergence(
  selectedRepo: Repository | null,
  currentBranch: string,
  isConnected: boolean
): BranchDivergenceState {
  const fetchDivergence = useCallback(
    async (repo: Repository, branch: string): Promise<BranchDivergence | null> => {
      const result = await window.electronAPI.lore.branchInfo(repo.localPath, branch);
      return result.success ? result.data : null;
    },
    []
  );

  const query = useRepoScopedQuery<BranchDivergence | null>(selectedRepo, fetchDivergence, null, {
    isConnected,
    key: currentBranch,
    enabled: currentBranch !== '',
    description: 'branch divergence',
    operation: 'useBranchDivergence',
  });

  return { divergence: query.value, isLoading: query.isLoading, refresh: query.refresh };
}
