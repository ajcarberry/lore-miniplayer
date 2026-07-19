import { useEffect, useState } from 'react';
import { logError } from '../utils/logging';

export interface RemoteRepository {
  readonly name: string;
  readonly url: string;
}

export interface RemoteRepositoriesState {
  readonly remoteRepos: RemoteRepository[];
  readonly isLoading: boolean;
  readonly loadError: string | null;
}

// Loads the repository listing from the connected Lore server whenever the
// consumer (the add-repository modal) is opened. Loading state is derived
// from the absence of data, keeping the effect free of synchronous setState.
export function useRemoteRepositories(serverUrl: string, opened: boolean): RemoteRepositoriesState {
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepository[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened || !serverUrl) {
      return undefined;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const result = await window.electronAPI.lore.repository.listRemoteRepositories(serverUrl);
        if (cancelled) {
          return;
        }
        if (result.success) {
          setRemoteRepos(result.data);
          setLoadError(null);
        } else {
          setRemoteRepos([]);
          setLoadError(`Failed to load repositories from ${serverUrl}: ${result.error}`);
        }
      } catch (error) {
        logError('Failed to load remote repositories', {
          error,
          serverUrl,
          operation: 'useRemoteRepositories',
        });
        if (!cancelled) {
          setRemoteRepos([]);
          setLoadError(error instanceof Error ? error.message : 'Failed to load repositories');
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [opened, serverUrl]);

  return {
    remoteRepos: remoteRepos ?? [],
    isLoading: opened && serverUrl.length > 0 && remoteRepos === null,
    loadError,
  };
}
