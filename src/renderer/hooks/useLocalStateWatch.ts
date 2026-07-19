import { useEffect, useRef } from 'react';
import type { Repository } from '../../shared/types';

// How often the local state fingerprint is checked. Each tick is a single
// local DB read (~ms, no server traffic); matches the file-status cadence.
const LOCAL_STATE_POLL_MS = 3000;

// Catch-all for repository mutations made outside the app — CLI commits,
// amends, syncs, branch switches — which no server notification covers
// (the server never hears about unpushed local state). The working copy's
// current revision hash is fetched as a cheap fingerprint every tick, and
// `onChange` fires only when it moves; failed or degraded (empty) ticks
// are skipped without disturbing the baseline. Known blind spot: switching
// to a branch whose tip is the identical revision.
export function useLocalStateWatch(
  selectedRepo: Repository | null,
  isConnected: boolean,
  onChange: () => void
): void {
  // Ref so a new callback identity never restarts the watcher.
  const callbackRef = useRef(onChange);
  useEffect(() => {
    callbackRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!selectedRepo || !isConnected) {
      return undefined;
    }
    const { localPath } = selectedRepo;
    let cancelled = false;
    let lastRevision: string | null = null;

    const tick = async (): Promise<void> => {
      const result = await window.electronAPI.lore.currentRevision(localPath);
      if (cancelled || !result.success || result.data === '') {
        return;
      }
      const previous = lastRevision;
      lastRevision = result.data;
      if (previous !== null && previous !== result.data) {
        callbackRef.current();
      }
    };

    void tick();
    const interval = window.setInterval(() => void tick(), LOCAL_STATE_POLL_MS);
    return (): void => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedRepo, isConnected]);
}
