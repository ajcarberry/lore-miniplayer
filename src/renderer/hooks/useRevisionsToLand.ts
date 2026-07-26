import { useCallback } from 'react';
import type { Repository } from '../../shared/types';
import { useRepoScopedQuery } from './useRepoScopedQuery';

export interface RevisionsToLandState {
  readonly hasRevisionsToLand: boolean;
  readonly isLoading: boolean;
  readonly refresh: () => Promise<void>;
}

// Whether the current branch carries revisions its merge target lacks — the
// merge service's own ancestry predicate, gating the card's Merge entry so it
// never offers a merge that would land nothing (in sync, or already landed by
// this app or another client). Keyed on branch, target, AND the branch's tip
// revision, so any refresh that moves the tip (a commit, a sync, the
// landing's own merge commit) re-asks; a purely external change that leaves
// the local tip untouched waits for the next graph refresh. Degrades to
// `false` while loading or on failure — never a merge offer on unknown state.
export function useRevisionsToLand(
  selectedRepo: Repository | null,
  branchName: string,
  targetBranch: string,
  isConnected: boolean,
  tipRevision: string
): RevisionsToLandState {
  const fetchRevisionsToLand = useCallback(
    async (repo: Repository): Promise<boolean> => {
      const result = await window.electronAPI.lore.revisionsToLand({
        repositoryPath: repo.localPath,
        sourceBranch: branchName,
        targetBranch,
      });
      return result.success ? result.data : false;
    },
    [branchName, targetBranch]
  );

  const query = useRepoScopedQuery<boolean>(selectedRepo, fetchRevisionsToLand, false, {
    isConnected,
    // Composite identity only — never parsed: the fetcher closes over the
    // branches, and the tip component forces the refetch when it moves.
    key: `${branchName}|${targetBranch}|${tipRevision}`,
    enabled: branchName !== '' && targetBranch !== '' && branchName !== targetBranch,
    description: 'revisions to land',
    operation: 'useRevisionsToLand',
  });

  return { hasRevisionsToLand: query.value, isLoading: query.isLoading, refresh: query.refresh };
}
