import { useCallback, useState } from 'react';
import type { LoreBranch, Repository } from '../../shared/types';
import { useRepoScopedQuery } from './useRepoScopedQuery';

const EMPTY_BRANCHES: LoreBranch[] = [];

export interface BranchesState {
  readonly branches: LoreBranch[];
  readonly isLoading: boolean;
  readonly currentBranch: string;
  readonly setCurrentBranch: (branch: string) => void;
  readonly refresh: () => Promise<void>;
}

// Loads branches whenever the selected repository changes, deriving the
// current branch from each successfully fetched list; see useRepoScopedQuery
// for the identity-derived loading and stale-response semantics.
export function useBranches(selectedRepo: Repository | null, isConnected: boolean): BranchesState {
  const [currentBranch, setCurrentBranch] = useState<string>('main');

  const fetchBranches = useCallback(async (repo: Repository): Promise<LoreBranch[]> => {
    const result = await window.electronAPI.lore.repository.listBranches(repo.localPath);
    return result.success ? result.data : [];
  }, []);

  const deriveCurrentBranch = useCallback((branches: LoreBranch[]): void => {
    const current = branches.find(branch => branch.isCurrent);
    setCurrentBranch(current ? current.name : '');
  }, []);

  const query = useRepoScopedQuery(selectedRepo, fetchBranches, EMPTY_BRANCHES, {
    isConnected,
    description: 'branches',
    operation: 'useBranches',
    onSuccess: deriveCurrentBranch,
  });

  return {
    branches: query.value,
    isLoading: query.isLoading,
    currentBranch,
    setCurrentBranch,
    refresh: query.refresh,
  };
}
