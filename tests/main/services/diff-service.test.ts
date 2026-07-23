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
      getCurrentRevision: jest.fn<Promise<string>, [string]>(async () => 'cur-rev'),
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
      await expect(promise).rejects.toHaveProperty('errorType', 6);
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

  describe('compare — request validation', () => {
    it('rejects a request missing a repositoryPath before calling the SDK', async () => {
      // When: comparing with an invalid request
      const promise = service.compare({
        repositoryPath: '',
        source: { kind: 'workingTree' },
        target: { kind: 'workingTree' },
      });

      // Then: it throws before reaching fileDiff
      await expect(promise).rejects.toThrow();
      expect(mockLore.fileDiff).not.toHaveBeenCalled();
    });
  });

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

  describe('workspaceDirtyStats', () => {
    // The dirty set the card stats measure: exactly what `lore status --scan`
    // reports (untracked / unstaged / staged), with per-file line stats from a
    // current-revision -> working-tree fileDiff (P1 Findings (i)).
    function dirtyStatus(): LoreFileStatusGroup {
      return {
        untracked: [statusFile('add.txt', { isUntracked: true, isStaged: true })],
        unstaged: [statusFile('mod.txt'), statusFile('del.txt'), statusFile('bin.png')],
        staged: [statusFile('staged.txt', { isStaged: true })],
      };
    }

    it('builds one entry per dirty file, line stats from the current-revision -> working-tree diff (P1 i a/b/c/d)', async () => {
      // Given: the status scan reports five dirty files (an untracked add, a
      // modify, a delete, a binary change, and a staged modify), and fileDiff
      // (current revision -> working tree) streams the probe-verified patches:
      // an add is all-plus (action ADD), a delete is all-minus (action DELETE,
      // no error), a binary change is the `Binary files differ` sentinel.
      repository.getFileStatus.mockResolvedValueOnce(dirtyStatus());
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'add.txt',
              patch: '--- /dev/null\n+++ add.txt\n@@ -0,0 +1,3 @@\n+new-1\n+new-2\n+new-3\n',
              action: LoreFileAction.ADD,
            }),
            fileDiffEvent({
              path: 'mod.txt',
              patch: '--- mod.txt@1\n+++ mod.txt\n@@ -2 +2 @@\n-bravo\n+BRAVO-EDIT\n@@ -3,0 +4 @@\n+DELTA\n',
              action: LoreFileAction.KEEP,
            }),
            fileDiffEvent({
              path: 'del.txt',
              patch: '--- del.txt@1\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-two\n-three\n',
              action: LoreFileAction.DELETE,
            }),
            fileDiffEvent({ path: 'bin.png', patch: 'Binary files differ\n', action: LoreFileAction.KEEP }),
            fileDiffEvent({
              path: 'staged.txt',
              patch: '--- staged.txt@1\n+++ staged.txt\n@@ -1,0 +2 @@\n+STAGED-EDIT\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: computing the workspace's dirty-file stats
      const result = await service.workspaceDirtyStats('/repo');

      // Then: the status scan drove the file list, and the diff was taken from
      // the current revision to the working tree (empty target), filtered to
      // the dirty paths (absolutized against the repo — B1).
      expect(repository.getFileStatus).toHaveBeenCalledWith('/repo');
      expect(repository.getCurrentRevision).toHaveBeenCalledWith('/repo');
      const [, args] = mockLore.fileDiff.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args).toEqual({
        sourceRevision: 'cur-rev',
        targetRevision: '',
        paths: ['/repo/add.txt', '/repo/mod.txt', '/repo/del.txt', '/repo/bin.png', '/repo/staged.txt'],
      });
      // branchInfo/branchDiff are no longer part of the card-stats path.
      expect(mockLore.branchInfo).not.toHaveBeenCalled();
      expect(mockLore.branchDiff).not.toHaveBeenCalled();

      // Exactly one entry per dirty file (count == status scan's dirty count),
      // with signed line stats; the binary change is flagged and carries no
      // line stats (excluded from counts, still a file).
      expect(result).toEqual([
        {
          path: 'add.txt',
          action: 'added',
          patch: '--- /dev/null\n+++ add.txt\n@@ -0,0 +1,3 @@\n+new-1\n+new-2\n+new-3\n',
          binary: false,
          truncated: false,
          lineStats: { added: 3, removed: 0 },
        },
        {
          path: 'mod.txt',
          action: 'modified',
          patch: '--- mod.txt@1\n+++ mod.txt\n@@ -2 +2 @@\n-bravo\n+BRAVO-EDIT\n@@ -3,0 +4 @@\n+DELTA\n',
          binary: false,
          truncated: false,
          lineStats: { added: 2, removed: 1 },
        },
        {
          path: 'del.txt',
          action: 'deleted',
          patch: '--- del.txt@1\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-two\n-three\n',
          binary: false,
          truncated: false,
          lineStats: { added: 0, removed: 3 },
        },
        { path: 'bin.png', action: 'modified', binary: true, truncated: false },
        {
          path: 'staged.txt',
          action: 'modified',
          patch: '--- staged.txt@1\n+++ staged.txt\n@@ -1,0 +2 @@\n+STAGED-EDIT\n',
          binary: false,
          truncated: false,
          lineStats: { added: 1, removed: 0 },
        },
      ]);
      expect(result).toHaveLength(5);
    });

    it('returns [] without resolving a revision or diffing when the working tree is clean', async () => {
      // Given: the status scan reports nothing dirty (the beforeEach default)
      // When: computing the stats
      const result = await service.workspaceDirtyStats('/repo');

      // Then: no revision lookup, no diff, empty result
      expect(result).toEqual([]);
      expect(repository.getCurrentRevision).not.toHaveBeenCalled();
      expect(mockLore.fileDiff).not.toHaveBeenCalled();
    });

    it('de-duplicates a path carrying both staged and unstaged flags, counting it once (P1 i c)', async () => {
      // Given: the same path appears in more than one status group
      repository.getFileStatus.mockResolvedValueOnce({
        untracked: [],
        unstaged: [statusFile('dup.txt')],
        staged: [statusFile('dup.txt', { isStaged: true })],
      });
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'dup.txt',
              patch: '--- dup.txt@1\n+++ dup.txt\n@@ -1 +1 @@\n-a\n+b\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: computing the stats
      const result = await service.workspaceDirtyStats('/repo');

      // Then: the path is diffed once and counted once
      const [, args] = mockLore.fileDiff.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(args['paths']).toEqual(['/repo/dup.txt']);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ path: 'dup.txt', action: 'modified' });
    });

    it('still counts a dirty file the diff does not enumerate (staged change reverted on disk), zero line stats', async () => {
      // Given: a dirty staged file whose working tree matches the current
      // revision, so the current-revision -> working-tree diff yields nothing
      repository.getFileStatus.mockResolvedValueOnce({
        untracked: [],
        unstaged: [],
        staged: [statusFile('held.txt', { isStaged: true })],
      });
      mockLore.fileDiff.mockReturnValue(fluentMock() as never);

      // When: computing the stats
      const result = await service.workspaceDirtyStats('/repo');

      // Then: the file is still counted (count == dirty count) with no line delta
      expect(result).toEqual([
        {
          path: 'held.txt',
          action: 'modified',
          binary: false,
          truncated: false,
          lineStats: { added: 0, removed: 0 },
        },
      ]);
    });

    it('counts dirty files without diffing when no current revision resolves', async () => {
      // Given: dirty files but the current revision degrades to '' (a failed
      // local read) — no revision to diff from
      repository.getFileStatus.mockResolvedValueOnce({
        untracked: [statusFile('fresh.txt', { isUntracked: true })],
        unstaged: [statusFile('edit.txt')],
        staged: [],
      });
      repository.getCurrentRevision.mockResolvedValueOnce('');

      // When: computing the stats
      const result = await service.workspaceDirtyStats('/repo');

      // Then: fileDiff is skipped, but the dirty files are still counted with
      // their status-derived action and zero line stats
      expect(mockLore.fileDiff).not.toHaveBeenCalled();
      expect(result).toEqual([
        {
          path: 'fresh.txt',
          action: 'added',
          binary: false,
          truncated: false,
          lineStats: { added: 0, removed: 0 },
        },
        {
          path: 'edit.txt',
          action: 'modified',
          binary: false,
          truncated: false,
          lineStats: { added: 0, removed: 0 },
        },
      ]);
    });

    it('wraps a fileDiff LoreError as a DiffOperationError', async () => {
      // Given: dirty files, but the diff itself fails
      repository.getFileStatus.mockResolvedValueOnce({
        untracked: [],
        unstaged: [statusFile('mod.txt')],
        staged: [],
      });
      mockLore.fileDiff.mockReturnValue(fluentMock({ error: loreError(6, 'diff failed') }) as never);

      // When: computing the stats
      const promise = service.workspaceDirtyStats('/repo');

      // Then: the failure surfaces wrapped with context
      await expect(promise).rejects.toThrow(DiffOperationError);
      await expect(promise).rejects.toThrow('Failed to diff files');
    });
  });
});
