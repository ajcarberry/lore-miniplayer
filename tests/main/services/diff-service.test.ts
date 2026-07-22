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

function fileDiffEvent(data: { path: string; patch: string; action: LoreFileAction }): MockEvent {
  return { tag: LoreEventTag.FILE_DIFF, data };
}

describe('DiffService', () => {
  let service: DiffService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DiffService();
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

      // Then: paths reach the SDK call
      expect(mockLore.fileDiff).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { sourceRevision: 'r1', targetRevision: '', paths: ['a.txt', 'b.txt'] }
      );
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

  describe('branchVsParent', () => {
    function branchListEvent(id: string, name: string, latest: string): MockEvent {
      return { tag: LoreEventTag.BRANCH_LIST_ENTRY, data: { id, name, latest } };
    }

    it('diffs a branch against its resolved parent using branchDiff to enumerate changed paths', async () => {
      // Given: 'feature/x' has parent id 'main-id'; branchInfo (the same
      // real event in production) also carries each branch's own tip;
      // branchDiff reports one changed file, and fileDiff then supplies its
      // patch between the two tips
      mockLore.branchInfo.mockImplementation(((_globals: unknown, args: { branch: string }) => {
        if (args.branch === 'feature/x') {
          return fluentMock({
            events: [
              { tag: LoreEventTag.BRANCH_INFO, data: { parent: 'main-id', latest: 'feature-tip' } },
            ],
          });
        }
        if (args.branch === 'main') {
          return fluentMock({
            events: [{ tag: LoreEventTag.BRANCH_INFO, data: { parent: '', latest: 'main-tip' } }],
          });
        }
        return fluentMock();
      }) as never);
      mockLore.branchList.mockReturnValue(
        fluentMock({
          events: [
            branchListEvent('main-id', 'main', 'main-tip'),
            branchListEvent('feature-id', 'feature/x', 'feature-tip'),
          ],
        }) as never
      );
      mockLore.branchDiff.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_DIFF_CHANGE,
              data: { change: { path: 'a.txt', action: LoreFileAction.KEEP, automerged: false } },
            },
          ],
        }) as never
      );
      mockLore.fileDiff.mockReturnValue(
        fluentMock({
          events: [
            fileDiffEvent({
              path: 'a.txt',
              patch: '--- a.txt@1\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y\n',
              action: LoreFileAction.KEEP,
            }),
          ],
        }) as never
      );

      // When: diffing the branch against its parent
      const result = await service.branchVsParent('/repo', 'feature/x');

      // Then: branchDiff enumerated the change against the resolved parent
      // name, and fileDiff was scoped to just that path between the tips
      expect(mockLore.branchDiff).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { source: 'main', target: 'feature/x' }
      );
      expect(mockLore.fileDiff).toHaveBeenCalledWith(
        { repositoryPath: '/repo' },
        { sourceRevision: 'main-tip', targetRevision: 'feature-tip', paths: ['a.txt'] }
      );
      expect(result).toEqual([
        {
          path: 'a.txt',
          action: 'modified',
          patch: '--- a.txt@1\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y\n',
          binary: false,
          truncated: false,
          lineStats: { added: 1, removed: 1 },
        },
      ]);
    });

    it('returns an empty array without calling branchDiff when the branch has no parent', async () => {
      // Given: branchInfo reports an unknown (all-zero) parent id, as main does
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_INFO,
              data: { parent: '0000000000000000000000000000000000000000' },
            },
          ],
        }) as never
      );

      // When: diffing main (a root branch) against its parent
      const result = await service.branchVsParent('/repo', 'main');

      // Then: nothing to diff, and branchDiff was never called
      expect(result).toEqual([]);
      expect(mockLore.branchDiff).not.toHaveBeenCalled();
    });

    it('returns an empty array without calling fileDiff when branchDiff reports no changes', async () => {
      // Given: a resolvable parent, but branchDiff streams no changes
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [{ tag: LoreEventTag.BRANCH_INFO, data: { parent: 'main-id' } }],
        }) as never
      );
      mockLore.branchList.mockReturnValue(
        fluentMock({
          events: [branchListEvent('main-id', 'main', 'main-tip')],
        }) as never
      );
      mockLore.branchDiff.mockReturnValue(fluentMock() as never);

      // When: diffing
      const result = await service.branchVsParent('/repo', 'feature/x');

      // Then: no changes means no fileDiff call
      expect(result).toEqual([]);
      expect(mockLore.fileDiff).not.toHaveBeenCalled();
    });

    it('wraps a branchDiff LoreError as a DiffOperationError', async () => {
      // Given: the parent resolves, but branchDiff itself fails
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [{ tag: LoreEventTag.BRANCH_INFO, data: { parent: 'main-id' } }],
        }) as never
      );
      mockLore.branchList.mockReturnValue(
        fluentMock({
          events: [branchListEvent('main-id', 'main', 'main-tip')],
        }) as never
      );
      mockLore.branchDiff.mockReturnValue(
        fluentMock({ error: loreError(9, 'diff failed') }) as never
      );

      // When: diffing
      const promise = service.branchVsParent('/repo', 'feature/x');

      // Then: the failure is wrapped with context
      await expect(promise).rejects.toThrow(DiffOperationError);
      await expect(promise).rejects.toThrow("Failed to diff branch 'feature/x' against its parent");
    });
  });
});
