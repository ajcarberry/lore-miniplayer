// Mock the Lore SDK completely so tests never load the native FFI layer. The
// enums subpath is NOT mocked — it is pure data and keeps event-tag
// assertions accurate. The lore-repository service is injected as a plain
// mock (status/commit/push/currentRevision), so it is not loaded here either.
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
      branchMergeStart: jest.fn(),
      branchMergeResolveMine: jest.fn(),
      branchMergeResolveTheirs: jest.fn(),
      branchMergeAbort: jest.fn(),
      branchPush: jest.fn(),
      branchInfo: jest.fn(),
      revisionHistory: jest.fn(),
    },
  };
});

import * as path from 'node:path';
import { lore, LoreError } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import { MergeService, MergeOperationError } from '../../../src/main/services/merge-service';
import type { LoreRepositoryService } from '../../../src/main/services/lore-repository';
import type { LoreFileStatus, LoreFileStatusGroup } from '../../../src/shared/types';
import { MergeStateSchema } from '../../../src/shared/schemas';

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

function conflictFileEvent(path: string): MockEvent {
  return { tag: LoreEventTag.BRANCH_MERGE_CONFLICT_FILE, data: { path } };
}

// Wires branchInfo (branch tip) + revisionHistory (lineage-by-hash) so the
// service's ahead-of-target computation resolves deterministically. `tips` maps
// branch name -> tip hash; `lineages` maps tip hash -> newest-first hash list.
function installAheadSignal(
  tips: Record<string, string>,
  lineages: Record<string, string[]>
): void {
  mockLore.branchInfo.mockImplementation(
    (_globals: unknown, args: { branch?: string }) =>
      fluentMock({
        events: [{ tag: LoreEventTag.BRANCH_INFO, data: { latest: tips[args.branch ?? ''] ?? '' } }],
      }) as never
  );
  mockLore.revisionHistory.mockImplementation(
    (_globals: unknown, args: { revision?: string }) =>
      fluentMock({
        events: (lineages[args.revision ?? ''] ?? []).map(revision => ({
          tag: LoreEventTag.REVISION_HISTORY_ENTRY,
          data: { revision },
        })),
      }) as never
  );
}

// A LoreFileStatus with the merge-relevant flags, defaulting the rest.
function fileStatus(path: string, flags: Partial<LoreFileStatus> = {}): LoreFileStatus {
  return {
    path,
    isUntracked: false,
    isStaged: true,
    conflict: false,
    ...flags,
  };
}

// Every merge file lands in a single group here; the service flattens all
// three groups, so the placement is irrelevant to the assertions.
function statusGroup(files: LoreFileStatus[]): LoreFileStatusGroup {
  return { untracked: [], unstaged: [], staged: files };
}

const mockLog = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as never;

const REPO = '/wt/agent-x';
const SOURCE = 'agent-x';
const TARGET = 'main';

describe('MergeService', () => {
  let lore_: jest.Mocked<LoreRepositoryService>;
  let service: MergeService;

  beforeEach(() => {
    jest.clearAllMocks();
    lore_ = {
      getFileStatus: jest.fn(async () => statusGroup([])),
      commit: jest.fn(async () => undefined),
      switchBranch: jest.fn(async () => undefined),
      getCurrentRevision: jest.fn(async () => 'merge-rev'),
    } as unknown as jest.Mocked<LoreRepositoryService>;
    // Default: the source branch is ahead — its lineage carries a commit the
    // target lacks (the common case). Individual tests override for the
    // nothing-to-land case.
    installAheadSignal(
      { [SOURCE]: 'source-tip', [TARGET]: 'target-tip' },
      { 'source-tip': ['source-tip', 'base'], 'target-tip': ['base'] }
    );
    service = new MergeService(mockLog, lore_);
  });

  function startRequest(): { repositoryPath: string; sourceBranch: string; targetBranch: string } {
    return { repositoryPath: REPO, sourceBranch: SOURCE, targetBranch: TARGET };
  }

  describe('start', () => {
    it('runs branchMergeStart with the target branch and noCommit, merging the target into the workspace checkout (P1e)', async () => {
      // Given: a clean merge — no conflict files, one automerged file
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('auto.txt', { conflictAutomerged: true })])
      );

      // When: starting a merge
      const state = await service.start(startRequest());

      // Then: branchMergeStart merges the TARGET branch into the current
      // (source) checkout, with auto-commit disabled so completion commits
      expect(mockLore.branchMergeStart).toHaveBeenCalledWith(
        { repositoryPath: REPO },
        { branch: TARGET, noCommit: true }
      );
      // And: a clean merge exposes the automerged file and is completable
      expect(MergeStateSchema.safeParse(state).success).toBe(true);
      expect(state).toEqual({
        sourceBranch: SOURCE,
        targetBranch: TARGET,
        files: [{ path: 'auto.txt', state: 'merged' }],
        allResolved: true,
        hasChangesToLand: true,
      });
    });

    it('reports the branch is ahead when phase-1 is clean but the branch has commits the target lacks (nothing-to-merge bug)', async () => {
      // Given: the target has not moved since the branch diverged, so merging it
      // into the branch is a no-op — no conflicts, no auto-merges — but the
      // branch still carries a commit the target lacks.
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      installAheadSignal(
        { [SOURCE]: 'branch-tip', [TARGET]: 'base' },
        { 'branch-tip': ['branch-tip', 'base'], base: ['base'] }
      );

      // When: starting the merge
      const state = await service.start(startRequest());

      // Then: no rows and no conflicts, yet the merge would land the branch's
      // commit — so it is NOT "nothing to merge".
      expect(state.files).toEqual([]);
      expect(state.allResolved).toBe(true);
      expect(state.hasChangesToLand).toBe(true);
    });

    it('reports nothing to land when the branch tip is already on the target', async () => {
      // Given: a clean phase-1 update AND the branch tip is the target tip —
      // the branch has never diverged, there is genuinely nothing to merge.
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      installAheadSignal(
        { [SOURCE]: 'shared-tip', [TARGET]: 'shared-tip' },
        { 'shared-tip': ['shared-tip', 'base'] }
      );

      // When: starting the merge
      const state = await service.start(startRequest());

      // Then: there is nothing to land
      expect(state.files).toEqual([]);
      expect(state.allResolved).toBe(true);
      expect(state.hasChangesToLand).toBe(false);
    });

    it('exposes conflicted files (unresolved) alongside automerged files', async () => {
      // Given: one conflict file and one automerged file
      mockLore.branchMergeStart.mockReturnValue(
        fluentMock({ events: [conflictFileEvent('conf.txt')] }) as never
      );
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([
          fileStatus('conf.txt', { conflict: true, conflictUnresolved: true }),
          fileStatus('auto.txt', { conflictAutomerged: true }),
        ])
      );

      // When: starting a merge with a conflict
      const state = await service.start(startRequest());

      // Then: the conflict is unresolved and the merge is not completable
      expect(state.allResolved).toBe(false);
      expect(state.files).toContainEqual({ path: 'conf.txt', state: 'conflict' });
      expect(state.files).toContainEqual({ path: 'auto.txt', state: 'merged' });
    });

    it('refuses a concurrent merge for the same repository with a typed error', async () => {
      // Given: a merge already started
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      await service.start(startRequest());

      // When/Then: a second start for the same repo is refused
      await expect(service.start(startRequest())).rejects.toBeInstanceOf(MergeOperationError);
      expect(mockLore.branchMergeStart).toHaveBeenCalledTimes(1);
    });

    it('wraps an SDK failure in a MergeOperationError and leaves no merge in flight', async () => {
      // Given: branchMergeStart throws
      mockLore.branchMergeStart.mockReturnValue(
        fluentMock({ error: loreError(7, 'boom') }) as never
      );

      // When/Then: the failure is surfaced as a typed error
      await expect(service.start(startRequest())).rejects.toBeInstanceOf(MergeOperationError);

      // And: no merge is registered — a subsequent start is allowed to run
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      await expect(service.start(startRequest())).resolves.toBeDefined();
    });
  });

  describe('resolve', () => {
    beforeEach(async () => {
      mockLore.branchMergeStart.mockReturnValue(
        fluentMock({ events: [conflictFileEvent('conf.txt')] }) as never
      );
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictUnresolved: true })])
      );
      await service.start(startRequest());
    });

    it('resolves a file as mine and reflects the resolution + all-resolved state', async () => {
      // Given: branchMergeResolveMine succeeds and status now flags the file mine
      mockLore.branchMergeResolveMine.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictMine: true })])
      );

      // When: resolving the conflict as mine
      const state = await service.resolve({
        repositoryPath: REPO,
        path: 'conf.txt',
        resolution: 'mine',
      });

      // Then: the SDK resolved the single path as mine, addressed by its
      // repo-ABSOLUTE path (P1e-addendum: relative paths are PATH_IGNOREd)
      expect(mockLore.branchMergeResolveMine).toHaveBeenCalledWith(
        { repositoryPath: REPO },
        { paths: [path.join(REPO, 'conf.txt')] }
      );
      expect(state.files).toEqual([{ path: 'conf.txt', state: 'conflict', resolution: 'mine' }]);
      expect(state.allResolved).toBe(true);
    });

    it('resolves a file as theirs', async () => {
      // Given: branchMergeResolveTheirs succeeds and status flags the file theirs
      mockLore.branchMergeResolveTheirs.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictTheirs: true })])
      );

      // When: resolving the conflict as theirs
      const state = await service.resolve({
        repositoryPath: REPO,
        path: 'conf.txt',
        resolution: 'theirs',
      });

      // Then: the SDK resolved the path as theirs (repo-absolute) and the file reflects it
      expect(mockLore.branchMergeResolveTheirs).toHaveBeenCalledWith(
        { repositoryPath: REPO },
        { paths: [path.join(REPO, 'conf.txt')] }
      );
      expect(state.files).toEqual([{ path: 'conf.txt', state: 'conflict', resolution: 'theirs' }]);
    });

    it('re-resolves a file the other way without needing an explicit unresolve step', async () => {
      // Given: the file was first resolved as mine
      mockLore.branchMergeResolveMine.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictMine: true })])
      );
      await service.resolve({ repositoryPath: REPO, path: 'conf.txt', resolution: 'mine' });

      // When: switching the same file to theirs
      mockLore.branchMergeResolveTheirs.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictTheirs: true })])
      );
      const state = await service.resolve({
        repositoryPath: REPO,
        path: 'conf.txt',
        resolution: 'theirs',
      });

      // Then: the switch just re-runs resolveTheirs — no unresolve op exists
      expect(mockLore.branchMergeResolveTheirs).toHaveBeenCalledWith(
        { repositoryPath: REPO },
        { paths: [path.join(REPO, 'conf.txt')] }
      );
      expect(state.files[0]).toEqual({ path: 'conf.txt', state: 'conflict', resolution: 'theirs' });
    });

    it('refuses to resolve a path that is not a conflict in the current merge', async () => {
      // When/Then: resolving an unknown/non-conflict path is a typed error
      await expect(
        service.resolve({ repositoryPath: REPO, path: 'other.txt', resolution: 'mine' })
      ).rejects.toBeInstanceOf(MergeOperationError);
      expect(mockLore.branchMergeResolveMine).not.toHaveBeenCalled();
    });

    it('refuses to resolve when no merge is in progress', async () => {
      // When/Then: resolving on a repo with no active merge is a typed error
      await expect(
        service.resolve({ repositoryPath: '/other/repo', path: 'conf.txt', resolution: 'mine' })
      ).rejects.toBeInstanceOf(MergeOperationError);
    });
  });

  describe('abort', () => {
    it('aborts an in-flight merge and clears it so a new merge can start', async () => {
      // Given: an in-flight merge
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      await service.start(startRequest());

      // When: aborting
      mockLore.branchMergeAbort.mockReturnValue(fluentMock() as never);
      const result = await service.abort({ repositoryPath: REPO });

      // Then: the SDK abort ran and the merge is cleared (a new start is allowed)
      expect(mockLore.branchMergeAbort).toHaveBeenCalledWith({ repositoryPath: REPO }, {});
      expect(result).toEqual({ aborted: true });
      await expect(service.start(startRequest())).resolves.toBeDefined();
    });

    it('refuses to abort when no merge is in progress', async () => {
      await expect(service.abort({ repositoryPath: REPO })).rejects.toBeInstanceOf(
        MergeOperationError
      );
    });
  });

  describe('complete', () => {
    // A clean re-merge of source into target emits a START_END with no
    // conflicts (P1e-addendum approach A: feature already contains main).
    const cleanTargetMerge = (): unknown =>
      fluentMock({
        events: [
          {
            tag: LoreEventTag.BRANCH_MERGE_START_END,
            data: { hasConflicts: false, signature: 'sig', stats: {} },
          },
        ],
      });

    it('lands on the target: commits on source, re-merges clean into target, restores the checkout, pushes target, returns the landed revision', async () => {
      // Given: a clean, fully-resolved merge in the workspace (source) checkout
      mockLore.branchMergeStart.mockReturnValue(cleanTargetMerge() as never);
      mockLore.branchPush.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      // getCurrentRevision is read twice: the workspace merge-commit, then the
      // landed revision on the target.
      lore_.getCurrentRevision
        .mockResolvedValueOnce('workspace-merge-rev')
        .mockResolvedValueOnce('landed-on-main-rev');
      await service.start(startRequest());

      // When: completing
      const result = await service.complete({ repositoryPath: REPO });

      // Then: phase 1 commits the resolved merge on the source branch, and
      // phase 2 lands it on the target branch
      expect(lore_.commit).toHaveBeenNthCalledWith(1, REPO, "Merge branch 'main' into 'agent-x'");
      expect(lore_.commit).toHaveBeenNthCalledWith(2, REPO, "Merge branch 'agent-x' into 'main'");
      // And: the checkout is switched to the target to land, then restored
      expect(lore_.switchBranch).toHaveBeenNthCalledWith(1, REPO, TARGET);
      expect(lore_.switchBranch).toHaveBeenNthCalledWith(2, REPO, SOURCE);
      // And: the landing re-merge merges source into the target checkout
      expect(mockLore.branchMergeStart).toHaveBeenNthCalledWith(
        2,
        { repositoryPath: REPO },
        { branch: SOURCE, noCommit: true }
      );
      // And: the TARGET branch is pushed (not the current/source branch)
      expect(mockLore.branchPush).toHaveBeenCalledWith(
        { repositoryPath: REPO },
        { branch: TARGET }
      );
      // And: the landed revision on the target is returned
      expect(result).toEqual({ revision: 'landed-on-main-rev' });

      // And: the merge is cleared — a fresh start is allowed
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      await expect(service.start(startRequest())).resolves.toBeDefined();
    });

    it('refuses to complete while conflicts remain unresolved (nothing committed or landed)', async () => {
      // Given: a merge with an unresolved conflict
      mockLore.branchMergeStart.mockReturnValue(
        fluentMock({ events: [conflictFileEvent('conf.txt')] }) as never
      );
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictUnresolved: true })])
      );
      await service.start(startRequest());

      // When/Then: completion is refused and nothing is committed/switched/pushed
      await expect(service.complete({ repositoryPath: REPO })).rejects.toBeInstanceOf(
        MergeOperationError
      );
      expect(lore_.commit).not.toHaveBeenCalled();
      expect(lore_.switchBranch).not.toHaveBeenCalled();
      expect(mockLore.branchPush).not.toHaveBeenCalled();
    });

    it('refuses to complete when no merge is in progress', async () => {
      await expect(service.complete({ repositoryPath: REPO })).rejects.toBeInstanceOf(
        MergeOperationError
      );
    });

    it('when the landing step fails, keeps the workspace merge-commit intact, reports it, and restores the checkout', async () => {
      // Given: a clean merge; phase-1 commit succeeds (workspace-merge-rev),
      // but the landing re-merge into the target throws
      mockLore.branchMergeStart
        .mockReturnValueOnce(fluentMock() as never) // start()
        .mockReturnValue(fluentMock({ error: loreError(9, 'server down') }) as never); // landing
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      lore_.getCurrentRevision.mockResolvedValue('workspace-merge-rev');
      await service.start(startRequest());

      // When/Then: a typed error surfaces, reporting the intact workspace commit
      await expect(service.complete({ repositoryPath: REPO })).rejects.toThrow(
        /workspace-merge-rev/
      );

      // And: phase-1 committed the merge on the source branch exactly once
      expect(lore_.commit).toHaveBeenCalledTimes(1);
      expect(lore_.commit).toHaveBeenCalledWith(REPO, "Merge branch 'main' into 'agent-x'");
      // And: the checkout was restored to the source branch despite the failure
      expect(lore_.switchBranch).toHaveBeenLastCalledWith(REPO, SOURCE);
      // And: the target was never pushed
      expect(mockLore.branchPush).not.toHaveBeenCalled();

      // And: the merge is retained — a retry that lands does NOT re-commit
      // phase 1 (idempotent via the recorded workspace revision)
      jest.clearAllMocks();
      mockLore.branchMergeStart.mockReturnValue(cleanTargetMerge() as never);
      mockLore.branchPush.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      lore_.getCurrentRevision.mockResolvedValue('landed-on-main-rev');
      const result = await service.complete({ repositoryPath: REPO });
      // Phase 1 (the source-branch commit) is skipped; only the phase-2
      // target-branch commit runs on the retry.
      expect(lore_.commit).toHaveBeenCalledTimes(1);
      expect(lore_.commit).toHaveBeenCalledWith(REPO, "Merge branch 'agent-x' into 'main'");
      expect(mockLore.branchPush).toHaveBeenCalledWith(
        { repositoryPath: REPO },
        { branch: TARGET }
      );
      expect(result).toEqual({ revision: 'landed-on-main-rev' });
    });

    it('aborts the target-side merge and errors if the landing re-merge unexpectedly conflicts', async () => {
      // Given: a clean workspace merge, but the landing re-merge reports a
      // conflict (should never happen — source already contains target)
      mockLore.branchMergeStart
        .mockReturnValueOnce(fluentMock() as never) // start()
        .mockReturnValue(
          fluentMock({
            events: [
              {
                tag: LoreEventTag.BRANCH_MERGE_START_END,
                data: { hasConflicts: true, signature: 'sig', stats: {} },
              },
              conflictFileEvent('conf.txt'),
            ],
          }) as never
        ); // landing
      mockLore.branchMergeAbort.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      lore_.getCurrentRevision.mockResolvedValue('workspace-merge-rev');
      await service.start(startRequest());

      // When/Then: completion errors, the target-side merge is aborted, and the
      // checkout is restored
      await expect(service.complete({ repositoryPath: REPO })).rejects.toBeInstanceOf(
        MergeOperationError
      );
      expect(mockLore.branchMergeAbort).toHaveBeenCalledWith({ repositoryPath: REPO }, {});
      expect(lore_.switchBranch).toHaveBeenLastCalledWith(REPO, SOURCE);
      expect(mockLore.branchPush).not.toHaveBeenCalled();
    });
  });
});
