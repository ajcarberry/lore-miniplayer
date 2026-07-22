import { useEffect, useState } from 'react';
import type { WorkspaceCard } from '../../shared/types';
import { WorkspaceModelSnapshotSchema } from '../../shared/schemas';
import { logError } from '../utils/logging';

interface RepoSnapshot {
  readonly repositoryId: string;
  readonly cards: WorkspaceCard[];
}

// Drives the workspace model for a repository: invokes `watch` (which warms the
// model's snapshot cache and returns the current snapshot), then keeps the
// cards live from the `onSnapshot` push. Every payload — the invoke result and
// each push — is Zod-validated and filtered to the watched repository before
// use, matching the other push channels. The last snapshot is stored with its
// repository id so switching repositories returns an empty list until the new
// repo's snapshot arrives, without a synchronous reset in the effect.
export function useMissionControlSnapshot(repositoryId: string | null): WorkspaceCard[] {
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null);

  useEffect(() => {
    if (repositoryId === null) {
      return undefined;
    }
    let cancelled = false;

    // Subscribe before watching so a snapshot emitted during watch() is not
    // missed.
    const removeListener = window.electronAPI.missionControl.onSnapshot(payload => {
      const parsed = WorkspaceModelSnapshotSchema.safeParse(payload);
      if (!parsed.success || parsed.data.repositoryId !== repositoryId) {
        return;
      }
      setSnapshot({ repositoryId, cards: parsed.data.cards });
    });

    void window.electronAPI.missionControl.watch(repositoryId).then(result => {
      if (cancelled) {
        return;
      }
      if (!result.success) {
        logError('Failed to watch workspace model', {
          error: result.error,
          repositoryId,
          operation: 'useMissionControlSnapshot',
        });
        return;
      }
      if (result.data.repositoryId === repositoryId) {
        setSnapshot({ repositoryId, cards: result.data.cards });
      }
    });

    return (): void => {
      cancelled = true;
      removeListener();
    };
  }, [repositoryId]);

  // Only surface cards that belong to the currently-watched repository; a stale
  // snapshot from a previous repo is discarded here rather than via setState.
  return snapshot && snapshot.repositoryId === repositoryId ? snapshot.cards : [];
}
