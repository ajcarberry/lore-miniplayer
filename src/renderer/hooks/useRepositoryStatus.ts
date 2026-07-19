import { useCallback } from 'react';
import type { LoreRepositoryStatus, Repository } from '../../shared/types';
import { useRepoScopedQuery } from './useRepoScopedQuery';

export interface RepositoryStatusState {
  readonly repoStatus: LoreRepositoryStatus | null;
  readonly isChecking: boolean;
  readonly refresh: () => Promise<void>;
}

// Checks whether the selected repository's path is an existing working copy;
// see useRepoScopedQuery for the identity-derived loading and stale-response
// semantics.
export function useRepositoryStatus(
  selectedRepo: Repository | null,
  isConnected: boolean
): RepositoryStatusState {
  const fetchStatus = useCallback(
    async (repo: Repository): Promise<LoreRepositoryStatus | null> => {
      const result = await window.electronAPI.lore.repository.checkStatus(repo.localPath);
      return result.success ? result.data : null;
    },
    []
  );

  const query = useRepoScopedQuery<LoreRepositoryStatus | null>(selectedRepo, fetchStatus, null, {
    isConnected,
    description: 'repository status',
    operation: 'useRepositoryStatus',
  });

  return { repoStatus: query.value, isChecking: query.isLoading, refresh: query.refresh };
}
