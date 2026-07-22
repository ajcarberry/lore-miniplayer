import { useCallback, useEffect, useState } from 'react';
import type { Repository } from '../../shared/types';
import { logError } from '../utils/logging';

export interface RepositoriesState {
  readonly repositories: Repository[];
  readonly isLoading: boolean;
  readonly selectedRepo: Repository | null;
  readonly selectRepository: (repo: Repository | null) => void;
  readonly refresh: () => Promise<void>;
}

// Loads the stored repositories once connected; the first repository is
// auto-selected. `repositories === null` doubles as the loading indicator so
// the initial fetch effect never needs a synchronous setState.
// `includeProvisioned` (U2) surfaces every registry origin — the footer
// selector's flat list of all workspaces — while the default (card-view-only)
// list is preserved for other callers (e.g. Mission Control).
export function useRepositories(
  isConnected: boolean,
  includeProvisioned?: boolean
): RepositoriesState {
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Repository | null>(null);

  useEffect(() => {
    if (!isConnected) {
      return undefined;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      const result = await window.electronAPI.repository.list(includeProvisioned);
      if (cancelled) {
        return;
      }
      if (!result.success) {
        logError('Failed to load repositories', {
          error: result.error,
          operation: 'useRepositories',
        });
        setRepositories([]);
        return;
      }
      setRepositories(result.data);
      setSelectedRepo(previous => previous ?? result.data[0] ?? null);
    })();
    return (): void => {
      cancelled = true;
    };
  }, [isConnected, includeProvisioned]);

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.electronAPI.repository.list(includeProvisioned);
    if (!result.success) {
      logError('Failed to refresh repositories', {
        error: result.error,
        operation: 'useRepositories',
      });
      return;
    }
    setRepositories(result.data);
  }, [includeProvisioned]);

  return {
    repositories: repositories ?? [],
    isLoading: isConnected && repositories === null,
    selectedRepo,
    selectRepository: setSelectedRepo,
    refresh,
  };
}
