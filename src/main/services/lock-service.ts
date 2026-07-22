import { lore, LoreError } from '@lore-vcs/sdk';
import type { LoreFluentApi } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import type {
  LockQueryRequest,
  LockQueryResponse,
  LockReleaseRequest,
  LockReleaseResponse,
} from '../../shared/types';
import { LockQueryRequestSchema, LockReleaseRequestSchema } from '../../shared/schemas';
import { collectEvents } from './lore-events';
import type { LoreEventDataOf } from './lore-events';

export class LockOperationError extends Error {
  constructor(
    message: string,
    public readonly errorType?: number
  ) {
    super(message);
    this.name = 'LockOperationError';
  }
}

// Lock visibility (spec "Supporting signals": show + release, never
// enforce — v1 has no UI path to acquire a lock, only to see who holds one
// and release it). Follows the fluent call + event.clone() + LoreError
// wrapping pattern established by diff-service.ts / lore-repository.ts.
export class LockService {
  private toOperationError(context: string, error: unknown): LockOperationError {
    if (error instanceof LockOperationError) {
      return error;
    }
    if (error instanceof LoreError) {
      const firstError = error.loreErrors?.[0];
      return new LockOperationError(`${context}: ${error.message}`, firstError?.data.errorType);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new LockOperationError(`${context}: ${message}`);
  }

  private collect<TTag extends LoreEventTag, T>(
    operation: LoreFluentApi,
    tag: TTag,
    map: (data: LoreEventDataOf<TTag>) => T | undefined,
    context: string
  ): Promise<T[]> {
    return collectEvents(operation, tag, map, error => this.toOperationError(context, error));
  }

  // Lists current locks, optionally filtered to a set of paths. Backed by
  // lockFileQuery rather than lockFileStatus: only the query op's per-entry
  // data carries the owning branch, which LockEntry requires — a single
  // unfiltered query is fetched and, when `paths` is given, filtered
  // locally rather than issuing one query per path.
  async query(request: LockQueryRequest): Promise<LockQueryResponse> {
    const { repositoryPath, paths } = LockQueryRequestSchema.parse(request);
    const entries = await this.collect(
      lore.lockFileQuery({ repositoryPath }, {}),
      LoreEventTag.LOCK_FILE_QUERY,
      (data: LoreEventDataOf<LoreEventTag.LOCK_FILE_QUERY>) => ({
        path: data.path,
        userId: data.owner,
        branch: data.branch,
      }),
      'Failed to query locks'
    );
    if (!paths || paths.length === 0) {
      return entries;
    }
    const pathSet = new Set(paths);
    return entries.filter(entry => pathSet.has(entry.path));
  }

  // Releases locks on the given paths. A path with no matching lock is
  // simply absent from `released` (lockFileRelease reports it via a
  // separate not-found event this service doesn't need), never an error.
  async release(request: LockReleaseRequest): Promise<LockReleaseResponse> {
    const { repositoryPath, paths } = LockReleaseRequestSchema.parse(request);
    const released = await this.collect(
      lore.lockFileRelease({ repositoryPath }, { paths }),
      LoreEventTag.LOCK_FILE_RELEASE,
      (data: LoreEventDataOf<LoreEventTag.LOCK_FILE_RELEASE>) => data.path,
      'Failed to release locks'
    );
    return { released };
  }
}
