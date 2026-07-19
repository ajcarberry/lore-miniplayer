import { useCallback, useState } from 'react';
import type { LoreBranch, LoreSyncOptions, Repository } from '../../shared/types';
import { logError } from '../utils/logging';
import { notifyError } from '../utils/notify';

export interface SyncActionsState {
  readonly isCloning: boolean;
  readonly isSyncing: boolean;
  readonly clone: () => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly syncWithOptions: (options: LoreSyncOptions) => Promise<boolean>;
  readonly reset: () => Promise<boolean>;
}

interface SyncActionsDeps {
  readonly selectedRepo: Repository | null;
  readonly branches: LoreBranch[];
  readonly targetBranch: string;
  readonly refreshBranches: () => Promise<void>;
  readonly refreshStatus: () => Promise<void>;
  readonly refreshDivergence: () => Promise<void>;
  readonly refreshGraph: () => Promise<void>;
}

// Clone/sync/reset operations for the sync view. All entry points are event
// handlers; the modal-driven ones return whether they succeeded so callers
// can close their modal.
export function useSyncActions(deps: SyncActionsDeps): SyncActionsState {
  const {
    selectedRepo,
    branches,
    targetBranch,
    refreshBranches,
    refreshStatus,
    refreshDivergence,
    refreshGraph,
  } = deps;
  const [isCloning, setIsCloning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const clone = useCallback(async (): Promise<void> => {
    if (!selectedRepo) {
      return;
    }
    setIsCloning(true);
    try {
      const result = await window.electronAPI.lore.repository.clone(
        selectedRepo.url,
        selectedRepo.localPath
      );
      if (!result.success) {
        notifyError('Clone Failed', result.error);
        return;
      }
      await refreshStatus();
      await refreshBranches();
    } catch (error) {
      logError('Failed to clone repository', {
        error,
        repository: selectedRepo,
        operation: 'useSyncActions',
      });
      notifyError('Clone Failed', error);
    } finally {
      setIsCloning(false);
    }
  }, [selectedRepo, refreshStatus, refreshBranches]);

  const runSync = useCallback(
    async (
      failureTitle: string,
      branch: string | undefined,
      options?: LoreSyncOptions
    ): Promise<boolean> => {
      if (!selectedRepo) {
        return false;
      }
      setIsSyncing(true);
      try {
        const result =
          options === undefined
            ? await window.electronAPI.lore.repository.sync(selectedRepo.localPath, branch)
            : await window.electronAPI.lore.repository.sync(
                selectedRepo.localPath,
                branch,
                options
              );
        if (!result.success) {
          notifyError(failureTitle, result.error);
          return false;
        }
        await refreshBranches();
        // A successful sync can pull new revisions, move the current
        // revision, and change divergence, so both the branch graph and the
        // divergence badge need refreshing — covers plain sync, switch-&-sync,
        // sync-to-revision, and reset (all routed through this shared runner).
        await refreshDivergence();
        await refreshGraph();
        return true;
      } catch (error) {
        logError(`${failureTitle}`, {
          error,
          repository: selectedRepo,
          options,
          operation: 'useSyncActions',
        });
        notifyError(failureTitle, error);
        return false;
      } finally {
        setIsSyncing(false);
      }
    },
    [selectedRepo, refreshBranches, refreshDivergence, refreshGraph]
  );

  // Sync to the selected branch, switching first when it differs from the
  // repository's current branch
  const sync = useCallback(async (): Promise<void> => {
    const currentBranchObj = branches.find(branch => branch.isCurrent);
    const needsSwitch = currentBranchObj && currentBranchObj.name !== targetBranch;
    await runSync('Sync Failed', needsSwitch ? targetBranch : undefined);
  }, [branches, targetBranch, runSync]);

  const syncWithOptions = useCallback(
    async (options: LoreSyncOptions): Promise<boolean> =>
      runSync('Sync Failed', undefined, options),
    [runSync]
  );

  // Discards local changes by force-resetting to the current branch head
  const reset = useCallback(async (): Promise<boolean> => {
    const currentBranchObj = branches.find(branch => branch.isCurrent);
    if (!currentBranchObj) {
      notifyError('Reset Failed', new Error('No current branch found'));
      return false;
    }
    return runSync('Reset Failed', currentBranchObj.name, { reset: true, force: true });
  }, [branches, runSync]);

  return { isCloning, isSyncing, clone, sync, syncWithOptions, reset };
}
