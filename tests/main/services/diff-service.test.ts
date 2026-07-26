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
      fileDiff: jest.fn(),
      branchDiff: jest.fn(),
      branchInfo: jest.fn(),
      branchList: jest.fn(),
    },
  };
});

import { lore, LoreError } from '@lore-vcs/sdk';
import { LoreEventTag, LoreFileAction } from '@lore-vcs/sdk/types/enums';
import {
  DiffService,
  DiffOperationError,
  PATCH_TRUNCATION_LINE_CAP,
  computeLineStats,
} from '../../../src/main/services/diff-service';
import type { DiffRepositorySource } from '../../../src/main/services/diff-service';
import type { LoreFileStatus, LoreFileStatusGroup } from '../../../src/shared/types';

const mockLore = lore as jest.Mocked<typeof lore>;

// A status entry as the LoreRepository surface produces it (repo-relative path).
function statusFile(path: string, overrides: Partial<LoreFileStatus> = {}): LoreFileStatus {
  return { path, isUntracked: false, isStaged: false, conflict: false, ...overrides };
}

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

function fileDiffEvent(data: { path: string; patch: string; action: LoreFileAction }): MockEvent {
  return { tag: LoreEventTag.FILE_DIFF, data };
}

describe('DiffService', () => {
  let service: DiffService;
  let repository: jest.Mocked<DiffRepositorySource>;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = {
      getFileStatus: jest.fn<Promise<LoreFileStatusGroup>, [string]>(async () => ({
        untracked: [],
        unstaged: [],
        staged: [],
      })),
    };
    service = new DiffService(repository);
  });

  describe('compare — CompareTarget resolution', () => {
    it('diffs a revision against the working tree (P1 finding a: empty targetRevision)', async () => {
      // Given: a modified file between r1 and the uncommitted working tree
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'a.txt',
              patch: '--- a.txt@1\n+++ a.txt\n@@ -2 +2 @@\n-bravo\n+BRAVO-EDIT\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: comparing revision r1 to the working tree
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: fileDiff is called with an empty targetRevision, and the
      // result carries the modified action, patch, and correct lineStats
      expect(mockLore.fileDiff).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { sourceRevision: 'r1', targetRevision: '' }
      );
      expect(result).toEqual([
        {
          path: 'a.txt',
          action: 'modified',
          patch: '--- a.txt@1\n+++ a.txt\n@@ -2 +2 @@\n-bravo\n+BRAVO-EDIT\n',
          binary: false,
          truncated: false,
          lineStats: { added: 1, removed: 1 },
        },
      ]);
    });

    it('diffs two explicit revisions', async () => {
      // Given: a file added between r1 and r2
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'new.txt',
              patch: '--- /dev/null\n+++ new.txt\n@@ -0,0 +1 @@\n+hello\n',
              action: LoreFileAction.ADD,
            }),
          ],
        }) as never
      );

      // When: comparing two revisions directly
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'revision', revision: 'r2' },
      });

      // Then: fileDiff receives both revisions and the file is mapped 'added'
      expect(mockLore.fileDiff).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { sourceRevision: 'r1', targetRevision: 'r2' }
      );
      expect(result[0]).toMatchObject({ path: 'new.txt', action: 'added' });
    });

    it('resolves a branchHead target to its tip revision via branchInfo', async () => {
      // Given: branchInfo reports the branch's latest revision
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [{ tag: LoreEventTag.BRANCH_INFO, data: { latest: 'branch-tip-rev' } }],
        }) as never
      );
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: comparing a revision to a branch's head
      await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r128' },
        target: { kind: 'branchHead', branch: 'feature/x' },
      });

      // Then: branchInfo resolved the branch name, and its tip fed fileDiff
      expect(mockLore.branchInfo).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { branch: 'feature/x' }
      );
      expect(mockLore.fileDiff).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { sourceRevision: 'r128', targetRevision: 'branch-tip-rev' }
      );
    });

    it('throws when a branchHead target has no resolvable revision', async () => {
      // Given: branchInfo streams no BRANCH_INFO event
      mockLore.branchInfo.mockReturnValue(fluentMock() as never);

      // When: comparing against an unresolvable branch
      const promise = service.compare({
        repositoryPath: '/repo',
        source: { kind: 'workingTree' },
        target: { kind: 'branchHead', branch: 'ghost' },
      });

      // Then: it throws a clear DiffOperationError, never reaching fileDiff
      await expect(promise).rejects.toThrow(DiffOperationError);
      await expect(promise).rejects.toThrow("Branch 'ghost' has no known revision");
      expect(mockLore.fileDiff).not.toHaveBeenCalled();
    });

    it('passes an optional paths filter through to fileDiff', async () => {
      // Given: the SDK resolves with no events
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: comparing with a paths filter
      await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
        paths: ['a.txt', 'b.txt'],
      });

      // Then: the repo-relative paths are absolutized against repositoryPath
      // before reaching the SDK (the SDK resolves relative path args against
      // the process CWD, not repositoryPath — see toAbsolutePath)
      expect(mockLore.fileDiff).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { sourceRevision: 'r1', targetRevision: '', paths: ['/repo/a.txt', '/repo/b.txt'] }
      );
    });

    it('strips the repository prefix from an absolute path echoed by fileDiff', async () => {
      // Given: fileDiff echoes back the repo-ABSOLUTE path it was queried
      // with (the app/UI works only in repo-relative paths)
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: '/repo/Content/Caves/pass_1.txt',
              patch: '--- x@1\n+++ x\n@@ -1 +1 @@\n-a\n+b\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: comparing
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: the result path is repo-relative, not the absolute echo
      expect(result[0]?.path).toBe('Content/Caves/pass_1.txt');
    });

    it('omits the paths key entirely when no filter is given', async () => {
      // Given: the SDK resolves with no events
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: comparing without a paths filter
      await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: the args object carries no paths key at all
      const [, args] = mockLore.fileDiff.mock.calls[0] as [unknown, Record<string, unknown>];
      expect('paths' in args).toBe(false);
    });
  });

  describe('compare — working-tree list is a superset of the dirty set', () => {
    // Regression guard (mission 2026-07-23): the Mission Control card counts the
    // status-scan dirty set exactly, but the review window's list comes from
    // `fileDiff(source -> working tree)`, which OMITS a dirty file whose working
    // tree matches the source revision (a change staged, then reverted on disk).
    // A working-tree compare must still list every such file so the card count
    // and the review list agree and nothing is un-committable.
    it('backfills a dirty file the working-tree diff omits (staged then reverted on disk)', async () => {
      // Given: the scan reports 'f.txt' dirty (staged), but fileDiff enumerates
      // nothing for it — the working tree was reverted to match the revision.
      repository.getFileStatus.mockResolvedValueOnce({
        untracked: [],
        unstaged: [],
        staged: [statusFile('f.txt', { isStaged: true })],
      });
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: comparing the current revision against the working tree
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: 'f.txt' is still listed as a zero-delta modified entry, not dropped
      expect(result).toEqual([
        {
          path: 'f.txt',
          action: 'modified',
          binary: false,
          truncated: false,
          lineStats: { added: 0, removed: 0 },
        },
      ]);
    });

    it('lists at least every file the status scan reports dirty (superset guard)', async () => {
      // Given: fileDiff enumerates an add and a modify, but the scan also reports
      // a third dirty file the working-tree diff omits.
      repository.getFileStatus.mockResolvedValueOnce({
        untracked: [statusFile('added.txt', { isUntracked: true })],
        unstaged: [statusFile('mod.txt')],
        staged: [statusFile('staged-reverted.txt', { isStaged: true })],
      });
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'added.txt',
              patch: '--- /dev/null\n+++ added.txt\n@@ -0,0 +1 @@\n+x\n',
              action: LoreFileAction.ADD,
            }),
            fileDiffEvent({
              path: 'mod.txt',
              patch: '--- mod.txt@1\n+++ mod.txt\n@@ -1 +1 @@\n-a\n+b\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: comparing the current revision against the working tree
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: every dirty path the scan reported is present (backfill preserves
      // the enumerated diffs and appends the omitted one)
      const paths = result.map(file => file.path);
      for (const dirty of ['added.txt', 'mod.txt', 'staged-reverted.txt']) {
        expect(paths).toContain(dirty);
      }
      expect(result.find(file => file.path === 'staged-reverted.txt')).toEqual({
        path: 'staged-reverted.txt',
        action: 'modified',
        binary: false,
        truncated: false,
        lineStats: { added: 0, removed: 0 },
      });
    });

    it('backfills an omitted untracked file as an added entry', async () => {
      // Given: the scan reports an untracked file, but fileDiff omits it.
      repository.getFileStatus.mockResolvedValueOnce({
        untracked: [statusFile('new.txt', { isUntracked: true })],
        unstaged: [],
        staged: [],
      });
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: comparing against the working tree
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: the untracked file is backfilled with the 'added' action
      expect(result).toEqual([
        {
          path: 'new.txt',
          action: 'added',
          binary: false,
          truncated: false,
          lineStats: { added: 0, removed: 0 },
        },
      ]);
    });

    it('does not consult the status scan for a revision-to-revision compare', async () => {
      // Given: a two-revision compare has no working tree, so no dirty set applies
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: comparing two explicit revisions
      await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'revision', revision: 'r2' },
      });

      // Then: the status scan is never queried (no working-tree backfill)
      expect(repository.getFileStatus).not.toHaveBeenCalled();
    });

    it('does not backfill when a path filter is active (caller asked for a subset)', async () => {
      // Given: a working-tree compare scoped to a specific path
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: comparing with a paths filter
      await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
        paths: ['a.txt'],
      });

      // Then: the dirty-set backfill is skipped (the caller requested a subset)
      expect(repository.getFileStatus).not.toHaveBeenCalled();
    });
  });

  describe('compare — file action mapping', () => {
    it.each([
      [LoreFileAction.ADD, 'added'],
      [LoreFileAction.DELETE, 'deleted'],
      [LoreFileAction.MOVE, 'moved'],
      [LoreFileAction.KEEP, 'modified'],
    ] as const)('maps LoreFileAction %s to %s', async (sdkAction, expected) => {
      // Given: a single FILE_DIFF event with a given SDK action
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'f.txt',
              patch: '--- f.txt@1\n+++ f.txt\n@@ -1 +1 @@\n-a\n+b\n',
              action: sdkAction,
            }),
          ],
        }) as never
      );

      // When: comparing
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: the action is mapped to the shared schema's vocabulary
      expect(result[0]?.action).toBe(expected);
    });
  });

  describe('compare — binary detection', () => {
    it('flags a file with no patch text as binary, dropping patch and lineStats', async () => {
      // Given: fileDiff streams no patch text for a modified file (no SDK
      // primitive flags binary directly; an empty patch on a non-move change
      // is the signal — see the code comment in diff-service.ts)
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [fileDiffEvent({ path: 'image.png', patch: '', action: LoreFileAction.KEEP })],
        }) as never
      );

      // When: comparing
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: the file is flagged binary with no patch or lineStats
      expect(result).toEqual([
        { path: 'image.png', action: 'modified', binary: true, truncated: false },
      ]);
    });

    it('flags the SDK `Binary files differ` sentinel patch as binary (P1 Findings i)', async () => {
      // Given: fileDiff emits the literal binary sentinel (probed against a
      // live binary file — NOT empty patch, NOT unified-diff text)
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'logo.png',
              patch: 'Binary files differ\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: comparing
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: the file is flagged binary with no patch or lineStats
      expect(result).toEqual([
        { path: 'logo.png', action: 'modified', binary: true, truncated: false },
      ]);
    });

    it('does not flag a pure rename (no content change) as binary', async () => {
      // Given: a moved file with an empty patch (path changed, content did not)
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [fileDiffEvent({ path: 'renamed.txt', patch: '', action: LoreFileAction.MOVE })],
        }) as never
      );

      // When: comparing
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: it is a plain moved file, not binary
      expect(result).toEqual([
        {
          path: 'renamed.txt',
          action: 'moved',
          patch: '',
          binary: false,
          truncated: false,
          lineStats: { added: 0, removed: 0 },
        },
      ]);
    });
  });

  describe('compare — truncation', () => {
    it('truncates a patch over the line cap and reports the full lineStats', async () => {
      // Given: a patch with more added lines than the truncation cap
      const lineCount = PATCH_TRUNCATION_LINE_CAP + 500;
      const patch = Array.from({ length: lineCount }, (_v, i) => `+line${i}`).join('\n');
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [fileDiffEvent({ path: 'huge.txt', patch, action: LoreFileAction.ADD })],
        }) as never
      );

      // When: comparing
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: truncated is set, only the head of the patch is kept, and
      // lineStats reflects the FULL patch (computed before truncation)
      const [file] = result;
      expect(file?.truncated).toBe(true);
      expect(file?.patch?.split('\n')).toHaveLength(PATCH_TRUNCATION_LINE_CAP);
      expect(file?.lineStats).toEqual({ added: lineCount, removed: 0 });
    });

    it('does not truncate a patch within the cap', async () => {
      // Given: a small patch
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'small.txt',
              patch: '--- small.txt@1\n+++ small.txt\n@@ -1 +1 @@\n-a\n+b\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: comparing
      const result = await service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'r1' },
        target: { kind: 'workingTree' },
      });

      // Then: truncated is false
      expect(result[0]?.truncated).toBe(false);
    });
  });

  describe('compare — LoreError passthrough', () => {
    it('wraps a fileDiff LoreError as a DiffOperationError with the SDK detail', async () => {
      // Given: the SDK rejects with a LoreError
      mockLore.fileDiff.mockReturnValue(
        fluentMock({ error: loreError(6, 'No such revision') }) as never
      );

      // When: comparing
      const promise = service.compare({
        repositoryPath: '/repo',
        source: { kind: 'revision', revision: 'bogus' },
        target: { kind: 'workingTree' },
      });

      // Then: it throws DiffOperationError carrying context and SDK detail
      await expect(promise).rejects.toThrow(DiffOperationError);
      await expect(promise).rejects.toThrow('Failed to diff files');
      await expect(promise).rejects.toThrow('No such revision');
    });

    it('wraps a branchInfo LoreError when resolving a branchHead target', async () => {
      // Given: branchInfo rejects
      mockLore.branchInfo.mockReturnValue(
        fluentMock({ error: loreError(3, 'No such branch') }) as never
      );

      // When: comparing against that branch
      const promise = service.compare({
        repositoryPath: '/repo',
        source: { kind: 'workingTree' },
        target: { kind: 'branchHead', branch: 'missing' },
      });

      // Then: the branchInfo error propagates, wrapped
      await expect(promise).rejects.toThrow(DiffOperationError);
      await expect(promise).rejects.toThrow("Failed to resolve branch 'missing'");
    });
  });

  // Request validation lives at the IPC boundary (validators.ts, covered by
  // tests/main/ipc/validators.test.ts) — the service takes typed requests.

  describe('computeLineStats', () => {
    it('counts + and - lines while ignoring the +++/--- file headers', () => {
      // When: computing stats on a patch with header lines and two hunks
      const stats = computeLineStats(
        '--- a.txt@1\n+++ a.txt\n@@ -1,2 +1,2 @@\n-old1\n+new1\n-old2\n+new2\n context\n'
      );

      // Then: only the hunk +/- lines are counted
      expect(stats).toEqual({ added: 2, removed: 2 });
    });

    it('returns zero stats for an empty patch', () => {
      expect(computeLineStats('')).toEqual({ added: 0, removed: 0 });
    });
  });
});
