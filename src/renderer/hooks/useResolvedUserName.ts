import { useEffect, useState } from 'react';
import { logError } from '../utils/logging';

// Module-level cache, mirroring the main process's own resolveUserName cache
// (src/main/services/lore-repository.ts): a resolved name rarely changes
// within a session, so once a userId is resolved for a repository every
// other toast for the same pair reuses it without a fresh IPC round-trip.
// Keyed identically to the main-process cache (`${repositoryPath}::${userId}`).
const nameCache = new Map<string, string>();

interface Resolution {
  readonly key: string;
  readonly name: string;
}

// Resolves a notification's raw userId to a display name for the
// attribution toast (P5's resolveUserName, exposed over IPC). Returns null
// while unresolved (no cache entry yet and the invoke hasn't settled) or on
// a failed lookup — callers fall back to the raw userId in that case, per
// the spec's "never fabricate" rule. `repositoryPath`/`userId` of null skips
// the fetch entirely (e.g. no toast currently queued).
export function useResolvedUserName(
  repositoryPath: string | null,
  userId: string | null
): string | null {
  const key = repositoryPath && userId ? `${repositoryPath}::${userId}` : null;
  // Only a resolved-in-this-effect result; a cache hit is read directly at
  // return time below so it renders immediately, without a setState round
  // trip through the effect.
  const [resolution, setResolution] = useState<Resolution | null>(null);

  useEffect(() => {
    if (!key || !repositoryPath || !userId || nameCache.has(key)) {
      return undefined;
    }

    let cancelled = false;
    void window.electronAPI.identity.resolveUserName({ repositoryPath, userId }).then(result => {
      if (cancelled) {
        return;
      }
      if (result.success) {
        nameCache.set(key, result.data.name);
        setResolution({ key, name: result.data.name });
      } else {
        logError('Failed to resolve user name', {
          error: result.error,
          repositoryPath,
          userId,
          operation: 'useResolvedUserName',
        });
      }
    });

    return (): void => {
      cancelled = true;
    };
  }, [key, repositoryPath, userId]);

  if (!key) {
    return null;
  }
  const cached = nameCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  return resolution && resolution.key === key ? resolution.name : null;
}
