import { useCallback, useEffect, useState } from 'react';
import type { Repository } from '../../shared/types';
import { logError } from '../utils/logging';

interface QueryData<T> {
  readonly repoId: string;
  readonly key: string;
  readonly value: T;
}

export interface RepoScopedQueryOptions<T> {
  readonly isConnected: boolean;
  // Extra identity component beyond the repository id (e.g. the current
  // branch). A response is discarded when either part of the identity has
  // been superseded by the time it arrives.
  readonly key?: string;
  // Gates the automatic fetch and refresh (e.g. no branch known yet).
  readonly enabled?: boolean;
  // Log-message subject, e.g. 'branch graph' → "Failed to load branch graph".
  readonly description: string;
  // logError `operation` context value (the calling hook's name).
  readonly operation: string;
  // Runs after each successfully fetched value has been applied (initial
  // load and refresh alike) — never after a failed fetch.
  readonly onSuccess?: (value: T) => void;
}

export interface RepoScopedQueryState<T> {
  readonly value: T;
  readonly isLoading: boolean;
  readonly refresh: () => Promise<void>;
}

// Generic identity-keyed fetch for data scoped to the selected repository
// (optionally plus a branch key). Loading state is derived by comparing the
// loaded data's identity with the current selection, so the fetch effect
// performs no synchronous setState; a stale response for a superseded
// selection can never overwrite the current one. On a failed fetch the state
// degrades to `empty` (initial load) or is left untouched (refresh).
export function useRepoScopedQuery<T>(
  selectedRepo: Repository | null,
  fetcher: (repo: Repository, key: string) => Promise<T>,
  empty: T,
  opts: RepoScopedQueryOptions<T>
): RepoScopedQueryState<T> {
  const { isConnected, key = '', enabled = true, description, operation, onSuccess } = opts;
  const hasKey = opts.key !== undefined;
  const [data, setData] = useState<QueryData<T> | null>(null);

  useEffect(() => {
    if (!selectedRepo || !isConnected || !enabled) {
      return undefined;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const value = await fetcher(selectedRepo, key);
        if (!cancelled) {
          setData({ repoId: selectedRepo.id, key, value });
          onSuccess?.(value);
        }
      } catch (error) {
        logError(`Failed to load ${description}`, {
          error,
          localPath: selectedRepo.localPath,
          ...(hasKey ? { branch: key } : {}),
          operation,
        });
        if (!cancelled) {
          setData({ repoId: selectedRepo.id, key, value: empty });
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [
    selectedRepo,
    key,
    isConnected,
    enabled,
    fetcher,
    onSuccess,
    empty,
    description,
    operation,
    hasKey,
  ]);

  // Event-handler refresh (after sync/commit/clone)
  const refresh = useCallback(async (): Promise<void> => {
    if (!selectedRepo || !enabled) {
      return;
    }
    try {
      const value = await fetcher(selectedRepo, key);
      setData({ repoId: selectedRepo.id, key, value });
      onSuccess?.(value);
    } catch (error) {
      logError(`Failed to refresh ${description}`, {
        error,
        localPath: selectedRepo.localPath,
        ...(hasKey ? { branch: key } : {}),
        operation,
      });
    }
  }, [selectedRepo, key, enabled, fetcher, onSuccess, description, operation, hasKey]);

  const isCurrent = data !== null && data.repoId === selectedRepo?.id && data.key === key;

  return {
    value: isCurrent ? data.value : empty,
    isLoading: selectedRepo !== null && isConnected && enabled && !isCurrent,
    refresh,
  };
}
