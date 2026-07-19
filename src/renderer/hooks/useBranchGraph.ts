import { useCallback } from 'react';
import type { BranchGraph, Repository } from '../../shared/types';
import { useRepoScopedQuery } from './useRepoScopedQuery';

// The empty graph rendered before any data has loaded (and after a failed
// load): no current revision, an unnamed empty child lane, no parent, no
// merges.
const EMPTY_GRAPH: BranchGraph = {
  current: '',
  branch: { name: '', revisions: [] },
  mergesFromParent: [],
  mergesToParent: [],
};

export interface BranchGraphState {
  readonly graph: BranchGraph;
  readonly isLoading: boolean;
  readonly refresh: () => Promise<void>;
}

// Loads the branch graph whenever the selected repository or current branch
// changes; see useRepoScopedQuery for the identity-derived loading and
// stale-response semantics.
export function useBranchGraph(
  selectedRepo: Repository | null,
  currentBranch: string,
  isConnected: boolean
): BranchGraphState {
  const fetchGraph = useCallback(async (repo: Repository, branch: string): Promise<BranchGraph> => {
    const result = await window.electronAPI.lore.branchGraph(repo.localPath, branch);
    return result.success ? result.data : EMPTY_GRAPH;
  }, []);

  const query = useRepoScopedQuery(selectedRepo, fetchGraph, EMPTY_GRAPH, {
    isConnected,
    key: currentBranch,
    enabled: currentBranch !== '',
    description: 'branch graph',
    operation: 'useBranchGraph',
  });

  return { graph: query.value, isLoading: query.isLoading, refresh: query.refresh };
}
