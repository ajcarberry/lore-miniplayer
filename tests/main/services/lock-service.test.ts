// Mock the Lore SDK completely so tests never load the native FFI layer. The
// enums subpath is NOT mocked — it is pure data and keeps event-tag
// assertions accurate.
jest.mock('@lore-vcs/sdk', () => {
  class LoreError extends Error {
    loreErrors: Array<{ tag: number; data: { errorType: number; errorInner: string } }> | undefined;

    constructor(
      loreErrors?: Array<{ tag: number; data: { errorType: number; errorInner: string } }>
    ) {
      const messages = loreErrors?.map(e => e.data.errorInner).filter(Boolean) ?? [];
      super(messages.length ? messages.join('\n') : 'Error when calling Lore');
      this.loreErrors = loreErrors;
    }
  }

  return {
    LoreError,
    lore: {
      lockFileQuery: jest.fn(),
      lockFileRelease: jest.fn(),
    },
  };
});

import { lore, LoreError } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import { LockService, LockOperationError } from '../../../src/main/services/lock-service';

const mockLore = lore as jest.Mocked<typeof lore>;

interface MockEvent {
  tag: number;
  data: Record<string, unknown>;
}

// Builds a fake fluent executor matching the SDK's
// lore.<op>(globals, args).callback(cb).waitAsync() contract.
function fluentMock({ events = [], error }: { events?: MockEvent[]; error?: Error } = {}): unknown {
  const chain = {
    registeredCallback: undefined as ((event: unknown) => void) | undefined,
    callback: jest.fn((cb: (event: unknown) => void): unknown => {
      chain.registeredCallback = cb;
      return chain;
    }),
    waitAsync: jest.fn(async (): Promise<number> => {
      for (const event of events) {
        chain.registeredCallback?.({
          ...event,
          clone: () => ({ tag: event.tag, data: event.data }),
        });
      }
      if (error) {
        throw error;
      }
      return 0;
    }),
  };
  return chain;
}

function loreError(errorType: number, errorInner: string): Error {
  return new LoreError([{ tag: LoreEventTag.ERROR, data: { errorType, errorInner } }] as never);
}

describe('LockService', () => {
  let service: LockService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LockService();
  });

  describe('query', () => {
    it('maps lockFileQuery entries to LockEntry', async () => {
      // Given: the SDK streams two locked files
      mockLore.lockFileQuery.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.LOCK_FILE_QUERY,
              data: { branch: 'main', path: 'a.txt', owner: 'user-1', lockedAt: 1000 },
            },
            {
              tag: LoreEventTag.LOCK_FILE_QUERY,
              data: { branch: 'main', path: 'b.txt', owner: 'user-2', lockedAt: 2000 },
            },
          ],
        }) as never
      );

      // When: querying without a path filter
      const entries = await service.query({ repositoryPath: '/repo' });

      // Then: entries are mapped to {path, userId, branch}
      expect(entries).toEqual([
        { path: 'a.txt', userId: 'user-1', branch: 'main' },
        { path: 'b.txt', userId: 'user-2', branch: 'main' },
      ]);
      expect(mockLore.lockFileQuery).toHaveBeenCalledWith({ repositoryPath: '/repo' }, {});
    });

    it('filters results to the requested paths', async () => {
      // Given: the SDK streams locks on three files
      mockLore.lockFileQuery.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.LOCK_FILE_QUERY,
              data: { branch: 'main', path: 'a.txt', owner: 'user-1', lockedAt: 1000 },
            },
            {
              tag: LoreEventTag.LOCK_FILE_QUERY,
              data: { branch: 'main', path: 'b.txt', owner: 'user-2', lockedAt: 2000 },
            },
            {
              tag: LoreEventTag.LOCK_FILE_QUERY,
              data: { branch: 'main', path: 'c.txt', owner: 'user-3', lockedAt: 3000 },
            },
          ],
        }) as never
      );

      // When: querying with a paths filter
      const entries = await service.query({ repositoryPath: '/repo', paths: ['b.txt'] });

      // Then: only the matching entry is returned
      expect(entries).toEqual([{ path: 'b.txt', userId: 'user-2', branch: 'main' }]);
    });

    it('returns an empty array when there are no locks', async () => {
      // Given: the SDK streams no lock entries
      mockLore.lockFileQuery.mockReturnValue(fluentMock() as never);

      // When: querying
      const entries = await service.query({ repositoryPath: '/repo' });

      // Then: the result is an empty array
      expect(entries).toEqual([]);
    });

    it('throws LockOperationError when the SDK operation fails', async () => {
      // Given: the SDK rejects
      mockLore.lockFileQuery.mockReturnValue(
        fluentMock({ error: loreError(9, 'Lock query failed') }) as never
      );

      // When: querying
      const promise = service.query({ repositoryPath: '/repo' });

      // Then: the failure is wrapped
      await expect(promise).rejects.toThrow(LockOperationError);
      await expect(promise).rejects.toThrow('Failed to query locks');
      await expect(promise).rejects.toThrow('Lock query failed');
      await expect(promise).rejects.toHaveProperty('errorType', 9);
    });
  });

  describe('release', () => {
    it('absolutizes repo-relative paths before calling lockFileRelease', async () => {
      // Given: the SDK releases two locks (the SDK resolves relative path
      // args against process CWD, not repositoryPath - see diff-service.ts)
      mockLore.lockFileRelease.mockReturnValue(
        fluentMock({
          events: [
            { tag: LoreEventTag.LOCK_FILE_RELEASE, data: { path: 'a.txt' } },
            { tag: LoreEventTag.LOCK_FILE_RELEASE, data: { path: 'b.txt' } },
          ],
        }) as never
      );

      // When: releasing locks on repo-relative paths
      const result = await service.release({ repositoryPath: '/repo', paths: ['a.txt', 'b.txt'] });

      // Then: the SDK is called with repo-absolute paths, and released echoes
      // the (unmodified) SDK output
      expect(mockLore.lockFileRelease).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { paths: ['/repo/a.txt', '/repo/b.txt'] }
      );
      expect(result).toEqual({ released: ['a.txt', 'b.txt'] });
    });

    it('leaves already-absolute paths unchanged', async () => {
      // Given: the SDK releases a lock on an already-absolute path
      mockLore.lockFileRelease.mockReturnValue(
        fluentMock({
          events: [{ tag: LoreEventTag.LOCK_FILE_RELEASE, data: { path: '/repo/a.txt' } }],
        }) as never
      );

      // When: releasing a lock given as a repo-absolute path
      await service.release({ repositoryPath: '/repo', paths: ['/repo/a.txt'] });

      // Then: the path is passed through unmodified, not double-joined
      expect(mockLore.lockFileRelease).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { paths: ['/repo/a.txt'] }
      );
    });

    it('rejects an empty paths array before calling the SDK', async () => {
      // Given: a release request with no paths

      // When: releasing with an empty paths array
      const promise = service.release({ repositoryPath: '/repo', paths: [] });

      // Then: schema validation rejects it and the SDK is never called
      await expect(promise).rejects.toThrow();
      expect(mockLore.lockFileRelease).not.toHaveBeenCalled();
    });

    it('reports no releases when nothing matched', async () => {
      // Given: the SDK streams no LOCK_FILE_RELEASE events (nothing found)
      mockLore.lockFileRelease.mockReturnValue(fluentMock() as never);

      // When: releasing a lock on an unlocked path
      const result = await service.release({ repositoryPath: '/repo', paths: ['unlocked.txt'] });

      // Then: released is empty, not an error
      expect(result).toEqual({ released: [] });
    });

    it('throws LockOperationError when the SDK operation fails', async () => {
      // Given: the SDK rejects
      mockLore.lockFileRelease.mockReturnValue(
        fluentMock({ error: loreError(11, 'Release failed') }) as never
      );

      // When: releasing
      const promise = service.release({ repositoryPath: '/repo', paths: ['a.txt'] });

      // Then: the failure is wrapped
      await expect(promise).rejects.toThrow(LockOperationError);
      await expect(promise).rejects.toThrow('Failed to release locks');
      await expect(promise).rejects.toHaveProperty('errorType', 11);
    });
  });
});
