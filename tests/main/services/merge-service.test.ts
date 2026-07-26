// Mock the Lore SDK completely so tests never load the native FFI layer. The
// enums subpath is NOT mocked — it is pure data and keeps event-tag
// assertions accurate. The lore-repository service is injected as a plain
// mock (status/commit/ancestry), so it is not loaded here either.
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
      branchMergeInto: jest.fn(),
      branchMergeResolveMine: jest.fn(),
      branchMergeResolveTheirs: jest.fn(),
      branchMergeAbort: jest.fn(),
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
import { abortActiveMerge } from '../../../src/main/services/merge-registry';

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

// A successful `branchMergeInto`: the landing streams the revision it created
// on the target branch, and needs no follow-up push (probed live).
function landingMock(revision = 'landed-on-main-rev'): unknown {
  return fluentMock({
    events: [
      { tag: LoreEventTag.BRANCH_MERGE_INTO_REVISION, data: { revision, revisionNumber: 4 } },
    ],
  });
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
// three groups, so the placement is irrelevant to the assertions — except for
// the staged pre-flight, which reads the staged group specifically.
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
      // commit resolves the committed revision the SDK streams
      // (REVISION_COMMIT_REVISION) — the service reads it from here.
      commit: jest.fn(async () => 'merge-rev'),
      // The checkout reports the source branch as current (C3's happy path).
      getWorkspaceRevisionStatus: jest.fn(async () => ({
        branchName: SOURCE,
        revision: 'source-tip',
        divergence: { state: 'ahead' as const, latest: 'source-tip', latestRemote: 'base' },
      })),
      // The ancestry gate and the revision a merge addresses live on the
      // repository service (shared with the workspace model's card gating);
      // their own semantics are covered in lore-repository.test.ts.
      hasRevisionsToLand: jest.fn(async () => true),
      getMergeTargetRevision: jest.fn(async () => 'target-tip'),
    } as unknown as jest.Mocked<LoreRepositoryService>;
    service = new MergeService(mockLog, lore_);
  });

  function startRequest(): { repositoryPath: string; sourceBranch: string; targetBranch: string } {
    return { repositoryPath: REPO, sourceBranch: SOURCE, targetBranch: TARGET };
  }

  describe('start', () => {
    it('runs branchMergeStart with the target branch and noCommit, merging the target into the workspace checkout (P1e)', async () => {
      // Given: a clean merge — no conflict files, one automerged file
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      // The first status read is start()'s pre-flight look at the checkout
      // (clean, no merge on disk); every later read is the merge's own state.
      lore_.getFileStatus.mockResolvedValueOnce(statusGroup([]));
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
        targetRevision: 'target-tip',
        files: [{ path: 'auto.txt', state: 'merged' }],
        allResolved: true,
        hasChangesToLand: true,
      });
    });

    it('names the revision the merge actually brought in — the target branch as the repository service resolves it', async () => {
      // Given: the target's addressed revision is its REMOTE tip (the local
      // store's tip lags a push, and a landing only advances the remote)
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      lore_.getMergeTargetRevision.mockResolvedValue('target-remote-tip');

      // When: starting the merge
      const state = await service.start(startRequest());

      // Then: the state names that revision, for the branch being merged in
      expect(lore_.getMergeTargetRevision).toHaveBeenCalledWith(REPO, TARGET);
      expect(state.targetRevision).toBe('target-remote-tip');
    });

    it('reports the branch is ahead when phase-1 is clean but the branch has commits the target lacks (nothing-to-merge bug)', async () => {
      // Given: the target has not moved since the branch diverged, so merging it
      // into the branch is a no-op — no conflicts, no auto-merges — but the
      // branch still carries a commit the target lacks.
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      lore_.hasRevisionsToLand.mockResolvedValue(true);

      // When: starting the merge
      const state = await service.start(startRequest());

      // Then: no rows and no conflicts, yet the merge would land the branch's
      // commit — so it is NOT "nothing to merge".
      expect(lore_.hasRevisionsToLand).toHaveBeenCalledWith(REPO, SOURCE, TARGET);
      expect(state.files).toEqual([]);
      expect(state.allResolved).toBe(true);
      expect(state.hasChangesToLand).toBe(true);
    });

    it('reports nothing to land when the branch has already been merged into the target', async () => {
      // Given: the branch's tip is already in the target's history — landed by
      // this app or by another client (T16). Merging it again would land
      // nothing.
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      lore_.hasRevisionsToLand.mockResolvedValue(false);

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
      lore_.getFileStatus.mockResolvedValueOnce(statusGroup([]));
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

    it('backs out the on-disk merge when a post-start step fails, leaving no stranded merge (C54)', async () => {
      // Given: branchMergeStart succeeds — the merge is materialized on disk —
      // but the ahead-of-target computation throws
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeAbort.mockReturnValue(fluentMock() as never);
      lore_.hasRevisionsToLand.mockRejectedValueOnce(new Error('branch info unavailable'));

      // When/Then: the failure surfaces as a typed error
      await expect(service.start(startRequest())).rejects.toBeInstanceOf(MergeOperationError);

      // And: the materialized merge was backed out on disk — the checkout is
      // not left mid-merge with no in-flight record
      expect(mockLore.branchMergeAbort).toHaveBeenCalledWith({ repositoryPath: REPO }, {});

      // And: no merge is registered — a retry of start() runs branchMergeStart
      // again and succeeds
      await expect(service.start(startRequest())).resolves.toBeDefined();
      expect(mockLore.branchMergeStart).toHaveBeenCalledTimes(2);
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
      lore_.getFileStatus.mockResolvedValueOnce(statusGroup([]));
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

  // Abort is deliberately tolerant (T16): the review window offers it from its
  // start-ERROR state, where no merge was ever recorded, and an on-disk merge
  // can outlive the in-memory record.
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

    it('backs out an on-disk merge this service never recorded', async () => {
      // Given: no in-flight record (the app restarted, or the window closed),
      // but the checkout still holds the merge
      mockLore.branchMergeAbort.mockReturnValue(fluentMock() as never);

      // When/Then: the abort still reaches the checkout and reports the backout
      await expect(service.abort({ repositoryPath: REPO })).resolves.toEqual({ aborted: true });
      expect(mockLore.branchMergeAbort).toHaveBeenCalledWith({ repositoryPath: REPO }, {});
    });

    it('reports a no-op instead of throwing when nothing is in progress', async () => {
      // Given: the SDK says there is no merge to abort — what the start-error
      // Abort affordance hits after a merge that never started
      mockLore.branchMergeAbort.mockReturnValue(
        fluentMock({ error: loreError(9, 'No merge is in progress') }) as never
      );

      // When/Then: the caller gets an honest "nothing to abort", not an error
      await expect(service.abort({ repositoryPath: REPO })).resolves.toEqual({ aborted: false });
    });

    it('still surfaces a real abort failure', async () => {
      // Given: the abort fails for a reason that is not "nothing to abort"
      mockLore.branchMergeAbort.mockReturnValue(
        fluentMock({ error: loreError(9, 'store is locked') }) as never
      );

      // When/Then: the failure is not swallowed
      await expect(service.abort({ repositoryPath: REPO })).rejects.toBeInstanceOf(
        MergeOperationError
      );
    });
  });

  describe('complete', () => {
    it('commits the resolved merge on the source branch, then lands it on the target with branchMergeInto', async () => {
      // Given: a clean, fully-resolved merge in the workspace (source) checkout
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeInto.mockReturnValue(landingMock() as never);
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      lore_.commit.mockResolvedValue('workspace-merge-rev');
      await service.start(startRequest());

      // When: completing
      const result = await service.complete({ repositoryPath: REPO });

      // Then: phase 1 commits the resolved merge on the source branch — the
      // ONLY commit this app makes; the landing commits itself
      expect(lore_.commit).toHaveBeenCalledTimes(1);
      expect(lore_.commit).toHaveBeenCalledWith(REPO, "Merge branch 'main' into 'agent-x'");
      // And: phase 2 lands it on the target from the source checkout, which
      // also publishes it — no branch switch, no separate push
      expect(mockLore.branchMergeInto).toHaveBeenCalledWith(
        { repositoryPath: REPO },
        { branch: TARGET, message: "Merge branch 'agent-x' into 'main'" }
      );
      // And: the landed revision on the target is returned
      expect(result).toEqual({ revision: 'landed-on-main-rev' });

      // And: the merge is cleared — a fresh start is allowed
      await expect(service.start(startRequest())).resolves.toBeDefined();
    });

    it('refuses to complete while conflicts remain unresolved (nothing committed or landed)', async () => {
      // Given: a merge with an unresolved conflict
      mockLore.branchMergeStart.mockReturnValue(
        fluentMock({ events: [conflictFileEvent('conf.txt')] }) as never
      );
      lore_.getFileStatus.mockResolvedValueOnce(statusGroup([]));
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictUnresolved: true })])
      );
      await service.start(startRequest());

      // When/Then: completion is refused and nothing is committed or landed
      await expect(service.complete({ repositoryPath: REPO })).rejects.toBeInstanceOf(
        MergeOperationError
      );
      expect(lore_.commit).not.toHaveBeenCalled();
      expect(mockLore.branchMergeInto).not.toHaveBeenCalled();
    });

    it('refuses to complete when no merge is in progress', async () => {
      await expect(service.complete({ repositoryPath: REPO })).rejects.toBeInstanceOf(
        MergeOperationError
      );
    });

    it('errors when the landing reports no revision at all', async () => {
      // Given: branchMergeInto resolves without streaming its revision — there
      // is no landed revision to report, and inventing one would be a lie
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeInto.mockReturnValue(fluentMock() as never);
      lore_.commit.mockResolvedValue('workspace-merge-rev');
      await service.start(startRequest());

      // When/Then: the failure names the intact workspace commit
      await expect(service.complete({ repositoryPath: REPO })).rejects.toThrow(
        /no landed revision/
      );
    });
  });

  // The guards that keep a merge from starting against the wrong checkout, or
  // on top of state branchMergeStart refuses to run over.
  describe('start guards (C3, A2-restart, staged pre-flight)', () => {
    it('refuses a start whose sourceBranch is not the checked-out branch, before anything is materialized (C3)', async () => {
      // Given: the checkout is on the target branch, not the requested source
      lore_.getWorkspaceRevisionStatus.mockResolvedValue({
        branchName: TARGET,
        revision: 'target-tip',
        divergence: { state: 'inSync', latest: 'target-tip', latestRemote: 'target-tip' },
      });
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);

      // When/Then: the request is refused with both branches named
      await expect(service.start(startRequest())).rejects.toThrow(
        new RegExp(`${SOURCE}[\\s\\S]*${TARGET}`)
      );
      await expect(service.start(startRequest())).rejects.toBeInstanceOf(MergeOperationError);
      // And: no merge was materialized on disk
      expect(mockLore.branchMergeStart).not.toHaveBeenCalled();
    });

    it('discards a merge left on disk by a previous session and re-runs it (A2-restart)', async () => {
      // Given: a merge is materialized on disk (conflict flags) but this
      // service instance has no record of it — the app restarted
      lore_.getFileStatus.mockResolvedValueOnce(
        statusGroup([fileStatus('conf.txt', { conflict: true, conflictUnresolved: true })])
      );
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      mockLore.branchMergeAbort.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeStart.mockReturnValue(
        fluentMock({ events: [conflictFileEvent('conf.txt')] }) as never
      );

      // When: the review window starts the merge again
      const state = await service.start(startRequest());

      // Then: the stale merge was backed out BEFORE the new one was started,
      // and the fresh merge's conflict is reported
      const abortOrder = mockLore.branchMergeAbort.mock.invocationCallOrder[0] ?? Infinity;
      const startOrder = mockLore.branchMergeStart.mock.invocationCallOrder[0] ?? 0;
      expect(abortOrder).toBeLessThan(startOrder);
      expect(state.files).toEqual([{ path: 'conf.txt', state: 'conflict' }]);
    });

    it('discards a stale merge whose ONLY trace is a staged row carrying no merge flag (A2-restart-import)', async () => {
      // Given: the previous session's merge was clean and merely IMPORTED a
      // target-only file. The SDK stages it with every conflict flag false, so
      // nothing on disk says "merge" — yet branchMergeStart refuses to run
      // over it ("Cannot merge with staged state").
      lore_.getFileStatus.mockResolvedValueOnce(
        statusGroup([fileStatus('imported.txt', { isUntracked: true })])
      );
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      mockLore.branchMergeAbort.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);

      // When/Then: it is recognised, backed out, and the merge re-runs
      await expect(service.start(startRequest())).resolves.toBeDefined();
      expect(mockLore.branchMergeAbort).toHaveBeenCalledWith({ repositoryPath: REPO }, {});
      expect(mockLore.branchMergeStart).toHaveBeenCalled();
    });

    it("refuses the user's own staged work by name instead of the SDK's opaque refusal", async () => {
      // Given: staged work that is NOT a stale merge — the abort finds nothing
      // to back out and the files are still staged afterwards
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('notes.txt'), fileStatus('assets/rock.tga')])
      );
      mockLore.branchMergeAbort.mockReturnValue(
        fluentMock({ error: loreError(9, 'No merge is in progress') }) as never
      );
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);

      // When/Then: the refusal names the files and the way out
      const failure = service.start(startRequest());
      await expect(failure).rejects.toBeInstanceOf(MergeOperationError);
      await expect(failure).rejects.toThrow(/assets\/rock\.tga, notes\.txt/);
      await expect(failure).rejects.toThrow(/Commit or unstage/);
      // And: nothing was materialized, and the user's staging was left alone
      expect(mockLore.branchMergeStart).not.toHaveBeenCalled();
    });

    it('starts without an abort when the checkout is clean', async () => {
      // Given: a clean checkout
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      await service.start(startRequest());
      // Then: nothing was backed out
      expect(mockLore.branchMergeAbort).not.toHaveBeenCalled();
    });
  });

  // The failure arcs of landing on the target branch: what the user is left
  // with, and whether a retry can finish the job (amendment bug A3).
  describe('landing failure arcs (A3)', () => {
    it('refuses to complete while unrelated staged work would ride the merge commit (A3-dirty)', async () => {
      // Given: a clean, resolved merge — and an unrelated file staged since
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      await service.start(startRequest());
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([
          fileStatus('merged.txt', { conflictAutomerged: true }),
          fileStatus('unrelated.txt'),
        ])
      );

      // When/Then: completion is refused, naming the unrelated file, and
      // nothing is committed or landed
      await expect(service.complete({ repositoryPath: REPO })).rejects.toThrow(/unrelated\.txt/);
      expect(lore_.commit).not.toHaveBeenCalled();
      expect(mockLore.branchMergeInto).not.toHaveBeenCalled();

      // And: the merge survives — unstaging the file lets it complete
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('merged.txt', { conflictAutomerged: true })])
      );
      mockLore.branchMergeInto.mockReturnValue(landingMock() as never);
      await expect(service.complete({ repositoryPath: REPO })).resolves.toBeDefined();
    });

    it('completes a merge whose own import the SDK stages with no merge flag at all (A3-import)', async () => {
      // Given: the target added a file the branch never had. branchMergeStart
      // stages it, and the status row carries NONE of the merge flags.
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      lore_.getFileStatus.mockResolvedValueOnce(statusGroup([])); // pre-flight: clean
      lore_.getFileStatus.mockResolvedValue(
        statusGroup([fileStatus('imported.txt', { isUntracked: true })])
      );
      await service.start(startRequest());

      // When/Then: the merge's own import does not trip the A3-dirty guard
      mockLore.branchMergeInto.mockReturnValue(landingMock() as never);
      await expect(service.complete({ repositoryPath: REPO })).resolves.toBeDefined();
    });

    it('a refused landing leaves the workspace merge-commit intact, and the retry lands without re-committing (A3-push)', async () => {
      // Given: a clean merge whose landing is refused by the server (a
      // protected target branch). branchMergeInto is atomic — nothing landed.
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeInto.mockReturnValue(
        fluentMock({ error: loreError(9, 'Not authorized to access repository') }) as never
      );
      lore_.commit.mockResolvedValue('workspace-merge-rev');
      await service.start(startRequest());

      // When/Then: a typed error reports the intact workspace merge commit
      await expect(service.complete({ repositoryPath: REPO })).rejects.toThrow(
        /workspace-merge-rev[\s\S]*failed to land/
      );
      expect(lore_.commit).toHaveBeenCalledTimes(1);

      // When: the cause clears and the user retries
      jest.clearAllMocks();
      mockLore.branchMergeInto.mockReturnValue(landingMock() as never);
      lore_.getFileStatus.mockResolvedValue(statusGroup([]));
      const result = await service.complete({ repositoryPath: REPO });

      // Then: phase 1 was NOT re-committed — the durable workspace merge-commit
      // was simply landed
      expect(lore_.commit).not.toHaveBeenCalled();
      expect(result).toEqual({ revision: 'landed-on-main-rev' });
    });

    it('reports a target that moved under the merge as an actionable error and discards the stale merge (A3-advanced)', async () => {
      // Given: the target advanced after the source branch merged it in, which
      // branchMergeInto refuses outright rather than conflicting
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeInto.mockReturnValue(
        fluentMock({
          error: loreError(
            9,
            'Target branch to merge into has a newer revision, merge target branch first'
          ),
        }) as never
      );
      lore_.commit.mockResolvedValue('workspace-merge-rev');
      await service.start(startRequest());

      // When/Then: the error names the moved target and the recovery
      await expect(service.complete({ repositoryPath: REPO })).rejects.toThrow(
        /advanced[\s\S]*start the merge again/
      );

      // And: the stale merge is discarded — retrying it would refuse forever,
      // so a fresh start() is what the message promises
      await expect(service.complete({ repositoryPath: REPO })).rejects.toThrow(
        /No merge is in progress/
      );
      await expect(service.start(startRequest())).resolves.toBeDefined();
    });

    it('exposes the in-flight merge to the window lifecycle, which aborts it (A2)', async () => {
      // Given: a merge in flight
      mockLore.branchMergeStart.mockReturnValue(fluentMock() as never);
      mockLore.branchMergeAbort.mockReturnValue(fluentMock() as never);
      await service.start(startRequest());

      // When: the review window closes and asks the registry to abort
      await expect(abortActiveMerge(REPO)).resolves.toBe(true);

      // Then: the merge was aborted and is no longer in flight
      expect(mockLore.branchMergeAbort).toHaveBeenCalledWith({ repositoryPath: REPO }, {});
      await expect(abortActiveMerge(REPO)).resolves.toBe(false);
      await expect(service.complete({ repositoryPath: REPO })).rejects.toThrow(
        /No merge is in progress/
      );
    });
  });
});
