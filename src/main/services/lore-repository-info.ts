import { lore } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import { collectEvents } from './lore-events';

// A checkout's true Lore identity, resolved from its on-disk `.lore/` config.
// The composed `url` (`<remoteUrl>/<name>`) is the grouping key for "same Lore
// repo"; `loreRepositoryId` is the drift-proof one. Extracted from
// lore-repository.ts to stay under the project's max-lines limit.
export interface RepositoryIdentity {
  url: string;
  loreRepositoryId?: string;
}

// Resolve a checkout's identity via `repositoryInfo` (REPOSITORY_DATA carries
// the server url, repo name, and a stable repository id). Returns undefined
// when the event has no usable url/name; throws (via `wrapError`) on SDK
// failure so a caller that must not block can wrap + degrade.
export async function resolveRepositoryIdentity(
  repositoryPath: string,
  wrapError: (context: string, error: unknown) => Error
): Promise<RepositoryIdentity | undefined> {
  const results = await collectEvents(
    lore.repositoryInfo({ repositoryPath }, {}),
    LoreEventTag.REPOSITORY_DATA,
    data => {
      const remoteUrl = String(data.remoteUrl ?? '');
      const name = String(data.name ?? '');
      if (!remoteUrl || !name) {
        return undefined;
      }
      return { remoteUrl, name, id: String(data.id ?? '') };
    },
    error => wrapError(`Failed to resolve repository identity for '${repositoryPath}'`, error)
  );
  const info = results[0];
  if (!info) {
    return undefined;
  }
  const url = `${info.remoteUrl.replace(/\/+$/, '')}/${info.name}`;
  return { url, ...(info.id ? { loreRepositoryId: info.id } : {}) };
}
