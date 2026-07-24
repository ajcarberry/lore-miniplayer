// Mock the Lore SDK completely so tests never load the native FFI layer.
// The enums subpath is NOT mocked — it is pure data and using the real
// values keeps event-tag assertions accurate.
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
      branchSwitch: jest.fn(),
      branchList: jest.fn(),
      branchInfo: jest.fn(),
      branchPush: jest.fn(),
      revisionSync: jest.fn(),
      revisionCommit: jest.fn(),
      revisionHistory: jest.fn(),
      revisionInfo: jest.fn(),
      repositoryClone: jest.fn(),
      repositoryList: jest.fn(),
      repositoryInfo: jest.fn(),
      repositoryStatus: jest.fn(),
      fileStage: jest.fn(),
      fileUnstage: jest.fn(),
      notificationSubscribe: jest.fn(),
      notificationUnsubscribe: jest.fn(),
      authUserInfo: jest.fn(),
      authLocalUserInfo: jest.fn(),
    },
  };
});

import { lore, LoreError } from '@lore-vcs/sdk';
import {
  LoreBranchLocation,
  LoreEventTag,
  LoreFileAction,
  LoreNodeType,
} from '@lore-vcs/sdk/types/enums';
import {
  LoreRepositoryService,
  LoreOperationError,
  deriveDivergence,
} from '../../../src/main/services/lore-repository';
import { branchInfoEventDataFixture } from '../../mocks/lore-branch-info-fixture';
import { revisionHistoryEntryEventDataFixture } from '../../mocks/lore-revision-history-fixture';
import {
  revisionMessageMetadataFixture,
  revisionTimestampMetadataFixture,
} from '../../mocks/lore-revision-info-fixture';
import {
  branchListEntriesFixture,
  featureBranchInfoFixture,
  mainBranchInfoFixture,
  featureHistoryFixture,
  mainHistoryFixture,
  extendedFeatureHistoryFixture,
  extendedMainHistoryFixture,
  MAIN_TIP,
  MAIN_R3,
  FEATURE_TIP,
  FEATURE_MERGE,
  FEATURE_CONTINUE,
  MAIN_MERGE_UP,
  MAIN_CONTINUE,
  BRANCH_POINT,
} from '../../mocks/lore-branch-graph-fixture';
import { BranchDivergenceSchema, BranchGraphSchema } from '../../../src/shared/schemas';

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
    filterByType: jest.fn((): unknown => chain),
    userContext: jest.fn((): unknown => chain),
    stringDecodeMode: jest.fn((): unknown => chain),
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

describe('LoreRepositoryService', () => {
  let service: LoreRepositoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LoreRepositoryService();
  });

  describe('switchBranch', () => {
    it('should throw LoreOperationError when the SDK operation fails', async () => {
      // Given: the SDK rejects with a LoreError
      mockLore.branchSwitch.mockReturnValue(
        fluentMock({ error: loreError(5, 'Cannot switch branch with staged files') }) as never
      );

      // When: switching branches
      const promise = service.switchBranch('/path/to/repo', 'feature-branch');

      // Then: it should throw LoreOperationError with context and SDK detail
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow("Failed to switch to branch 'feature-branch'");
      await expect(promise).rejects.toThrow('Cannot switch branch with staged files');
      await expect(promise).rejects.toHaveProperty('errorType', 5);
    });

    it('should succeed and address the repository via globals', async () => {
      // Given: the SDK resolves
      mockLore.branchSwitch.mockReturnValue(fluentMock() as never);

      // When: switching branches
      await expect(
        service.switchBranch('/path/to/repo', 'feature-branch')
      ).resolves.toBeUndefined();

      // Then: the SDK is called with (globals, args)
      expect(mockLore.branchSwitch).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { branch: 'feature-branch' }
      );
    });
  });

  describe('syncRepository', () => {
    it('should throw LoreOperationError when the sync fails', async () => {
      // Given: the SDK rejects
      mockLore.revisionSync.mockReturnValue(
        fluentMock({ error: loreError(2, 'Sync failed') }) as never
      );

      // When: syncing repository
      const promise = service.syncRepository('/path/to/repo');

      // Then: it should throw LoreOperationError
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow('Failed to sync repository');
    });

    it('should handle branch switching errors during sync', async () => {
      // Given: branch switch fails
      mockLore.branchSwitch.mockReturnValue(
        fluentMock({ error: loreError(1, 'No such branch') }) as never
      );

      // When: syncing with target branch
      const promise = service.syncRepository('/path/to/repo', 'target-branch');

      // Then: the branch-switch error propagates and sync is never attempted
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow("Failed to switch to branch 'target-branch'");
      expect(mockLore.revisionSync).not.toHaveBeenCalled();
    });

    it('should map sync options to SDK args and the force flag to globals', async () => {
      // Given: the SDK resolves
      mockLore.revisionSync.mockReturnValue(fluentMock() as never);

      // When: syncing with options
      await service.syncRepository('/path/to/repo', undefined, {
        revision: 'abc123',
        reset: true,
        forwardChanges: true,
        force: true,
      });

      // Then: options land in the right argument slots
      expect(mockLore.revisionSync).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo', force: true },
        { revision: 'abc123', reset: true, forwardChanges: true }
      );
    });
  });

  describe('cloneRepository', () => {
    it('should throw LoreOperationError when the clone fails', async () => {
      // Given: the SDK rejects
      mockLore.repositoryClone.mockReturnValue(
        fluentMock({ error: loreError(10, 'Repository not found') }) as never
      );

      // When: cloning repository
      const promise = service.cloneRepository('https://repo.url', '/local/path');

      // Then: it should throw LoreOperationError with details
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow("Failed to clone repository 'https://repo.url'");
      await expect(promise).rejects.toThrow('Repository not found');
    });

    it('should clone into the target path via globals', async () => {
      // Given: the SDK resolves
      mockLore.repositoryClone.mockReturnValue(fluentMock() as never);

      // When: cloning repository
      await service.cloneRepository('https://repo.url', '/local/path');

      // Then: the SDK is called with the clone destination as repositoryPath
      expect(mockLore.repositoryClone).toHaveBeenCalledWith(
        { repositoryPath: '/local/path' },
        { repositoryUrl: 'https://repo.url' }
      );
    });

    it('should emit cloneProgress with a byte-based percent while the clone streams', async () => {
      // Given: the SDK streams clone progress counts
      const countBase = {
        fileComplete: 0,
        fileRetain: 0,
        fileReplace: 0,
        fileCount: 4,
        fileInflight: 1,
        fragmentInflight: 0,
        discoveryComplete: 1,
      };
      mockLore.repositoryClone.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.REPOSITORY_CLONE_PROGRESS,
              data: { count: { ...countBase, bytesTransferred: 25, bytesTotal: 100 } },
            },
            {
              tag: LoreEventTag.REPOSITORY_CLONE_PROGRESS,
              data: { count: { ...countBase, bytesTransferred: 100, bytesTotal: 100 } },
            },
          ],
        }) as never
      );
      const progress: unknown[] = [];
      service.on('cloneProgress', p => progress.push(p));

      // When: cloning repository
      await service.cloneRepository('https://repo.url', '/local/path');

      // Then: progress is emitted with the destination path and byte ratio
      expect(progress).toEqual([
        { localPath: '/local/path', percent: 25 },
        { localPath: '/local/path', percent: 100 },
      ]);
    });

    it('should fall back to file counts while byte totals are unknown', async () => {
      // Given: an early progress event before byte discovery
      mockLore.repositoryClone.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.REPOSITORY_CLONE_PROGRESS,
              data: {
                count: {
                  fileComplete: 1,
                  fileRetain: 0,
                  fileReplace: 0,
                  fileCount: 4,
                  fileInflight: 1,
                  fragmentInflight: 0,
                  bytesTransferred: 0,
                  bytesTotal: 0,
                  discoveryComplete: 0,
                },
              },
            },
          ],
        }) as never
      );
      const progress: unknown[] = [];
      service.on('cloneProgress', p => progress.push(p));

      // When: cloning repository
      await service.cloneRepository('https://repo.url', '/local/path');

      // Then: the percent derives from completed vs discovered files
      expect(progress).toEqual([{ localPath: '/local/path', percent: 25 }]);
    });
  });

  describe('listBranches', () => {
    it('should map branch list entries and mark main as default', async () => {
      // Given: the SDK streams local and remote branch entries
      mockLore.branchList.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_LIST_ENTRY,
              data: { name: 'main', location: LoreBranchLocation.LOCAL, isCurrent: true },
            },
            {
              tag: LoreEventTag.BRANCH_LIST_ENTRY,
              data: { name: 'feature', location: LoreBranchLocation.REMOTE, isCurrent: false },
            },
          ],
        }) as never
      );

      // When: listing branches
      const branches = await service.listBranches('/path/to/repo');

      // Then: entries are mapped with isDefault derived from the branch name
      expect(branches).toEqual([
        { name: 'main', isDefault: true, isCurrent: true },
        { name: 'feature', isDefault: false, isCurrent: false },
      ]);
    });

    it('should dedupe branches present both locally and remotely', async () => {
      // Given: the same branch is reported from both locations
      mockLore.branchList.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_LIST_ENTRY,
              data: { name: 'main', location: LoreBranchLocation.LOCAL, isCurrent: true },
            },
            {
              tag: LoreEventTag.BRANCH_LIST_ENTRY,
              data: { name: 'main', location: LoreBranchLocation.REMOTE, isCurrent: false },
            },
          ],
        }) as never
      );

      // When: listing branches
      const branches = await service.listBranches('/path/to/repo');

      // Then: the local entry wins
      expect(branches).toEqual([{ name: 'main', isDefault: true, isCurrent: true }]);
    });
  });

  describe('deriveDivergence', () => {
    it('should report inSync when both hashes are non-empty and equal', () => {
      // When: latest and latestRemote match
      const state = deriveDivergence('a1b2c3', 'a1b2c3');

      // Then: the branch is in sync
      expect(state).toBe('inSync');
    });

    it('should report ahead when latestRemote is found in the local revision history', () => {
      // When: latest and latestRemote disagree, but latestRemote is an
      // ancestor reachable from local history (local has newer commits)
      const state = deriveDivergence('a1b2c3', 'd4e5f6', ['a1b2c3', 'd4e5f6', 'older']);

      // Then: local is ahead of the remote
      expect(state).toBe('ahead');
    });

    it('should report behindOrDiverged when latestRemote is not found in the local revision history', () => {
      // When: latest and latestRemote disagree, and latestRemote does not
      // appear anywhere in local history (remote has moved on)
      const state = deriveDivergence('a1b2c3', 'd4e5f6', ['a1b2c3', 'older']);

      // Then: the user's next action is to sync
      expect(state).toBe('behindOrDiverged');
    });

    it('should report behindOrDiverged when no local revision history is supplied and hashes differ', () => {
      // When: latest and latestRemote disagree and no history is given
      const state = deriveDivergence('a1b2c3', 'd4e5f6');

      // Then: it defaults to behindOrDiverged rather than assuming ahead
      expect(state).toBe('behindOrDiverged');
    });

    it('should report unknown when latestRemote is empty', () => {
      // When: no remote hash is known
      const state = deriveDivergence('a1b2c3', '');

      // Then: divergence cannot be determined
      expect(state).toBe('unknown');
    });

    it('should report unknown when latest is empty', () => {
      // When: no local hash is known
      const state = deriveDivergence('', 'a1b2c3');

      // Then: divergence cannot be determined
      expect(state).toBe('unknown');
    });

    it('should report unknown when a hash is all zeros', () => {
      // When: the remote hash is the zero/unset sentinel
      const state = deriveDivergence('a1b2c3', '0000000000000000000000000000000000000000');

      // Then: divergence cannot be determined
      expect(state).toBe('unknown');
    });

    it('should report unknown when both hashes are empty', () => {
      // When: neither hash is known
      const state = deriveDivergence('', '');

      // Then: divergence cannot be determined
      expect(state).toBe('unknown');
    });
  });

  describe('getBranchDivergence', () => {
    it('should map a BRANCH_INFO event to a BranchDivergence', async () => {
      // Given: the SDK streams a BRANCH_INFO event with matching hashes
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [{ tag: LoreEventTag.BRANCH_INFO, data: branchInfoEventDataFixture }],
        }) as never
      );

      // When: getting branch divergence
      const divergence = await service.getBranchDivergence('/path/to/repo', 'main');

      // Then: the result matches the shared schema and derives inSync
      expect(BranchDivergenceSchema.safeParse(divergence).success).toBe(true);
      expect(divergence).toEqual({
        state: 'inSync',
        latest: branchInfoEventDataFixture.latest,
        latestRemote: branchInfoEventDataFixture.latestRemote,
      });
      expect(mockLore.branchInfo).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { branch: 'main' }
      );
    });

    it('should derive ahead and walk local history (length 100, onlyBranch false) when hashes differ', async () => {
      // Given: the SDK streams a BRANCH_INFO event with differing hashes,
      // and local history includes the remote's hash further back
      const latestRemote = 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5';
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_INFO,
              data: { ...branchInfoEventDataFixture, latestRemote },
            },
          ],
        }) as never
      );
      mockLore.revisionHistory.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.REVISION_HISTORY_ENTRY,
              data: {
                ...revisionHistoryEntryEventDataFixture,
                revision: branchInfoEventDataFixture.latest,
              },
            },
            {
              tag: LoreEventTag.REVISION_HISTORY_ENTRY,
              data: { ...revisionHistoryEntryEventDataFixture, revision: latestRemote },
            },
          ],
        }) as never
      );

      // When: getting branch divergence
      const divergence = await service.getBranchDivergence('/path/to/repo', 'main');

      // Then: local is ahead, and the walk used the documented flags
      expect(divergence.state).toBe('ahead');
      expect(mockLore.revisionHistory).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { branch: 'main', length: 100, onlyBranch: false }
      );
    });

    it('should derive behindOrDiverged when the remote hash is not found in local history', async () => {
      // Given: differing hashes, and local history never reaches the remote's hash
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_INFO,
              data: {
                ...branchInfoEventDataFixture,
                latestRemote: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
              },
            },
          ],
        }) as never
      );
      mockLore.revisionHistory.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.REVISION_HISTORY_ENTRY,
              data: {
                ...revisionHistoryEntryEventDataFixture,
                revision: branchInfoEventDataFixture.latest,
              },
            },
          ],
        }) as never
      );

      // When: getting branch divergence
      const divergence = await service.getBranchDivergence('/path/to/repo', 'main');

      // Then: the user's next action is to sync
      expect(divergence.state).toBe('behindOrDiverged');
    });

    it('should skip the history walk when the branch is already in sync', async () => {
      // Given: matching hashes
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [{ tag: LoreEventTag.BRANCH_INFO, data: branchInfoEventDataFixture }],
        }) as never
      );

      // When: getting branch divergence
      await service.getBranchDivergence('/path/to/repo', 'main');

      // Then: no history walk was needed
      expect(mockLore.revisionHistory).not.toHaveBeenCalled();
    });

    it('should skip the history walk when divergence is unknown', async () => {
      // Given: no BRANCH_INFO event streamed, so hashes are empty
      mockLore.branchInfo.mockReturnValue(fluentMock() as never);

      // When: getting branch divergence
      const divergence = await service.getBranchDivergence('/path/to/repo', 'main');

      // Then: the result is unknown with empty hashes, and no walk was needed
      expect(divergence).toEqual({ state: 'unknown', latest: '', latestRemote: '' });
      expect(mockLore.revisionHistory).not.toHaveBeenCalled();
    });

    it('should throw LoreOperationError when the branchInfo SDK operation fails', async () => {
      // Given: the SDK rejects with a LoreError
      mockLore.branchInfo.mockReturnValue(
        fluentMock({ error: loreError(3, 'No such branch') }) as never
      );

      // When: getting branch divergence
      const promise = service.getBranchDivergence('/path/to/repo', 'missing-branch');

      // Then: it should throw LoreOperationError with context and SDK detail
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow("Failed to get branch divergence for 'missing-branch'");
      await expect(promise).rejects.toThrow('No such branch');
      await expect(promise).rejects.toHaveProperty('errorType', 3);
    });

    it('should throw LoreOperationError when the history-walk SDK operation fails', async () => {
      // Given: branchInfo resolves with differing hashes, but the follow-up
      // history walk fails
      mockLore.branchInfo.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.BRANCH_INFO,
              data: {
                ...branchInfoEventDataFixture,
                latestRemote: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
              },
            },
          ],
        }) as never
      );
      mockLore.revisionHistory.mockReturnValue(
        fluentMock({ error: loreError(4, 'History walk failed') }) as never
      );

      // When: getting branch divergence
      const promise = service.getBranchDivergence('/path/to/repo', 'main');

      // Then: it should throw LoreOperationError with context
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow("Failed to get branch divergence for 'main'");
    });
  });

  describe('getBranchGraph', () => {
    const ZERO = '0000000000000000000000000000000000000000';

    // Dispatch each SDK op to fixture events by argument shape, since
    // getBranchGraph fans out across branchList, branchInfo, and several
    // revisionHistory walks distinguished only by their args.
    function setupGraphMocks(
      options: {
        branchInfo?: MockEvent[] | Error;
        currentRev?: string;
        mainHistory?: typeof mainHistoryFixture;
        featureHistory?: typeof featureHistoryFixture;
        // Walk anchors for each lane — override together with the extended
        // history fixtures so branchList tips match the walked lineages.
        mainTip?: string;
        featureTip?: string;
        extraBranchEntries?: MockEvent[];
        revisionInfoEvents?: MockEvent[];
        currentFails?: boolean;
      } = {}
    ): void {
      const {
        branchInfo = [{ tag: LoreEventTag.BRANCH_INFO, data: featureBranchInfoFixture }],
        mainHistory = mainHistoryFixture,
        featureHistory = featureHistoryFixture,
        mainTip = MAIN_TIP,
        featureTip = FEATURE_TIP,
        currentRev = featureTip,
        extraBranchEntries = [],
        revisionInfoEvents = [],
        currentFails = false,
      } = options;

      mockLore.branchList.mockReturnValue(
        fluentMock({
          events: [
            ...branchListEntriesFixture.map(data => ({
              tag: LoreEventTag.BRANCH_LIST_ENTRY,
              data: { ...data, latest: data.name === 'main' ? mainTip : featureTip },
            })),
            ...extraBranchEntries,
          ],
        }) as never
      );

      mockLore.branchInfo.mockReturnValue(
        (Array.isArray(branchInfo)
          ? fluentMock({ events: branchInfo })
          : fluentMock({ error: branchInfo })) as never
      );

      mockLore.revisionHistory.mockImplementation(((_g: unknown, args: Record<string, unknown>) => {
        const revision = args['revision'] as string | undefined;
        const length = args['length'] as number | undefined;
        if (!revision && length === 1) {
          if (currentFails) {
            return fluentMock({ error: loreError(1, 'no working copy') });
          }
          return fluentMock({
            events: currentRev
              ? [
                  {
                    tag: LoreEventTag.REVISION_HISTORY_ENTRY,
                    data: { revision: currentRev, revisionNumber: 0, parent: [ZERO, ZERO] },
                  },
                ]
              : [],
          });
        }
        if (revision === mainTip) {
          return fluentMock({
            events: mainHistory.map(data => ({ tag: LoreEventTag.REVISION_HISTORY_ENTRY, data })),
          });
        }
        if (revision === featureTip) {
          return fluentMock({
            events: featureHistory.map(data => ({
              tag: LoreEventTag.REVISION_HISTORY_ENTRY,
              data,
            })),
          });
        }
        return fluentMock();
      }) as never);

      mockLore.revisionInfo.mockReturnValue(fluentMock({ events: revisionInfoEvents }) as never);
    }

    it('assembles child + parent lanes, current, and merges from the parent', async () => {
      // Given: a feature branch that forked from main and merged one main
      // revision back in
      setupGraphMocks();

      // When: assembling the graph for the child branch
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the current revision, both lanes, the branch point, and the
      // merge classification are all present and schema-valid
      expect(graph.current).toBe(FEATURE_TIP);
      expect(graph.branch.name).toBe('feature/x');
      expect(graph.branch.revisions.map(r => r.revision)).toEqual([
        FEATURE_TIP,
        FEATURE_MERGE,
        BRANCH_POINT,
      ]);
      expect(graph.parent?.name).toBe('main');
      expect(graph.parent?.branchPoint).toBe(BRANCH_POINT);
      expect(graph.parent?.revisions).toHaveLength(mainHistoryFixture.length);
      expect(graph.mergesFromParent).toEqual([{ child: FEATURE_MERGE, parentSource: MAIN_R3 }]);
      expect(BranchGraphSchema.safeParse(graph).success).toBe(true);

      // And: the child lane is walked unlimited (length 0) from its tip, the
      // parent lane capped-plus-one from the parent tip
      expect(mockLore.revisionHistory).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { revision: FEATURE_TIP, length: 0 }
      );
      expect(mockLore.revisionHistory).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { revision: MAIN_TIP, length: 101 }
      );
    });

    it('classifies a merge up (child accepted into the parent) and keeps both lanes walking past both merges', async () => {
      // Given: the extended flow — merge down (FEATURE_MERGE), child continues
      // (FEATURE_TIP), merge up into main (MAIN_MERGE_UP, other-parent on the
      // child lineage), then both branches continue past the merges
      setupGraphMocks({
        mainTip: MAIN_CONTINUE,
        featureTip: FEATURE_CONTINUE,
        mainHistory: extendedMainHistoryFixture,
        featureHistory: extendedFeatureHistoryFixture,
      });

      // When: assembling the graph for the child branch
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the merge up is classified with its true child-lineage source,
      // alongside the existing merge-down classification
      expect(graph.mergesToParent).toEqual([{ parent: MAIN_MERGE_UP, childSource: FEATURE_TIP }]);
      expect(graph.mergesFromParent).toEqual([{ child: FEATURE_MERGE, parentSource: MAIN_R3 }]);

      // And: both lanes continue beyond the merges — the continuation
      // revisions are the newest entry of each lane
      expect(graph.branch.revisions[0]?.revision).toBe(FEATURE_CONTINUE);
      expect(graph.parent?.revisions[0]?.revision).toBe(MAIN_CONTINUE);
      expect(BranchGraphSchema.safeParse(graph).success).toBe(true);
    });

    it('excludes a parent merge whose other-parent is NOT on the child lineage', async () => {
      // Given: a parent revision with a real, non-zero second parent, but
      // one that belongs to neither the child lineage nor is unknown — a
      // merge from some unrelated third branch, not the feature branch
      const unrelatedHash = 'u1u1u1u1u1u1u1u1u1u1u1u1u1u1u1u1u1u1u1u1';
      const mainWithUnrelatedMerge = [
        {
          revision: MAIN_MERGE_UP,
          revisionNumber: 5,
          parent: [MAIN_TIP, unrelatedHash] as [string, string],
        },
        ...mainHistoryFixture,
      ];
      setupGraphMocks({
        mainTip: MAIN_MERGE_UP,
        mainHistory: mainWithUnrelatedMerge,
      });

      // When: assembling the graph for the child branch
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the parent revision is NOT classified as a merge up, since its
      // other-parent isn't on the child lineage
      expect(graph.mergesToParent).toEqual([]);
    });

    it('omits the parent lane and merges for a branch with no parent (main)', async () => {
      // Given: main, whose branchInfo carries a zeroed parent id
      setupGraphMocks({
        branchInfo: [{ tag: LoreEventTag.BRANCH_INFO, data: mainBranchInfoFixture }],
        currentRev: MAIN_TIP,
      });

      // When: assembling the graph for main
      const graph = await service.getBranchGraph('/path/to/repo', 'main');

      // Then: there is no parent lane and no merges in either direction
      expect(graph.parent).toBeUndefined();
      expect(graph.mergesFromParent).toEqual([]);
      expect(graph.mergesToParent).toEqual([]);
      expect(graph.branch.name).toBe('main');
      expect(graph.branch.revisions.map(r => r.revision)).toEqual(
        mainHistoryFixture.map(r => r.revision)
      );
      expect(BranchGraphSchema.safeParse(graph).success).toBe(true);
    });

    it('degrades to no parent lane when branchInfo fails, without failing the graph', async () => {
      // Given: branchInfo rejects
      setupGraphMocks({ branchInfo: loreError(4, 'branch info unavailable') });

      // When: assembling the graph
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the child lane still resolves; the parent is simply omitted
      expect(graph.branch.revisions).toHaveLength(featureHistoryFixture.length);
      expect(graph.parent).toBeUndefined();
      expect(graph.mergesFromParent).toEqual([]);
    });

    it('omits the parent lane when the parent id does not resolve to a branch entry', async () => {
      // Given: branchInfo names a parent id that is not in the branch listing
      setupGraphMocks({
        branchInfo: [
          {
            tag: LoreEventTag.BRANCH_INFO,
            data: { ...featureBranchInfoFixture, parent: 'unlisted-parent-id' },
          },
        ],
      });

      // When: assembling the graph
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the parent lane is omitted
      expect(graph.parent).toBeUndefined();
    });

    it('returns an empty child lane when the branch is not in the listing', async () => {
      // Given: a request for a branch name absent from branchList
      setupGraphMocks();

      // When: assembling the graph for an unknown branch
      const graph = await service.getBranchGraph('/path/to/repo', 'ghost');

      // Then: the branch lane is empty but keeps the requested name
      expect(graph.branch.name).toBe('ghost');
      expect(graph.branch.revisions).toEqual([]);
    });

    it('prefers a non-zero remote tip when the local branch entry has none', async () => {
      // Given: feature/x also appears as a LOCAL entry with a zeroed tip
      setupGraphMocks({
        extraBranchEntries: [
          {
            tag: LoreEventTag.BRANCH_LIST_ENTRY,
            data: {
              id: featureBranchInfoFixture.id,
              name: 'feature/x',
              latest: ZERO,
              isCurrent: false,
              location: LoreBranchLocation.LOCAL,
            },
          },
        ],
      });

      // When: assembling the graph
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the walkable remote tip is used, not the zeroed local one
      expect(graph.branch.revisions.map(r => r.revision)).toEqual([
        FEATURE_TIP,
        FEATURE_MERGE,
        BRANCH_POINT,
      ]);
    });

    it('caps the parent lane at 100 revisions', async () => {
      // Given: a parent lineage of 101 revisions
      const longMain = Array.from({ length: 101 }, (_v, i) => ({
        revision: `main-${i}`,
        revisionNumber: 101 - i,
        parent: [i === 100 ? ZERO : `main-${i + 1}`, ZERO] as [string, string],
      }));
      setupGraphMocks({
        mainHistory: [
          { revision: MAIN_TIP, revisionNumber: 200, parent: ['main-0', ZERO] },
          ...longMain,
        ],
      });

      // When: assembling the graph
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the parent lane is trimmed to the cap
      expect(graph.parent?.revisions).toHaveLength(100);
    });

    it('degrades the current revision to an empty string when the walk fails', async () => {
      // Given: the unqualified current-revision walk rejects
      setupGraphMocks({ currentFails: true });

      // When: assembling the graph
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: current is empty but the rest of the graph still resolves
      expect(graph.current).toBe('');
      expect(graph.branch.revisions).toHaveLength(featureHistoryFixture.length);
    });

    it('enriches child revisions with message and timestamp from revisionInfo', async () => {
      // Given: revisionInfo streams metadata for each revision
      setupGraphMocks({
        revisionInfoEvents: [
          { tag: LoreEventTag.METADATA, data: revisionTimestampMetadataFixture },
          { tag: LoreEventTag.METADATA, data: revisionMessageMetadataFixture },
        ],
      });

      // When: assembling the graph
      const graph = await service.getBranchGraph('/path/to/repo', 'feature/x');

      // Then: the child lane carries the harvested message and timestamp
      expect(graph.branch.revisions[0]).toEqual({
        revision: FEATURE_TIP,
        revisionNumber: 3,
        message: revisionMessageMetadataFixture.value.data,
        timestamp: revisionTimestampMetadataFixture.value.data,
      });
    });

    it('throws when the branch listing fails', async () => {
      // Given: branchList rejects
      setupGraphMocks();
      mockLore.branchList.mockReturnValue(
        fluentMock({ error: loreError(4, 'listing failed') }) as never
      );

      // When/Then: the whole graph assembly fails with context
      await expect(service.getBranchGraph('/path/to/repo', 'feature/x')).rejects.toThrow(
        'Failed to list branches for graph'
      );
    });
  });

  describe('resolveRepositoryIdentity', () => {
    // REPOSITORY_DATA shape mirrors the live probe (2026-07-22): a checkout at
    // any path self-reports its server url, repo name, and stable repo id.
    const repositoryDataEvent = (data: Record<string, unknown>): MockEvent => ({
      tag: LoreEventTag.REPOSITORY_DATA,
      data,
    });

    it('composes <remoteUrl>/<name> and returns the stable repository id', async () => {
      // Given: repositoryInfo streams REPOSITORY_DATA for the checkout
      mockLore.repositoryInfo.mockReturnValue(
        fluentMock({
          events: [
            repositoryDataEvent({
              remoteUrl: 'lore://127.0.0.1',
              name: 'demo-project',
              id: '019f6e08-1234-4abc-8def-0123456789ab',
            }),
          ],
        }) as never
      );

      // When: resolving the identity at the checkout path
      const identity = await service.resolveRepositoryIdentity('/Users/alex/Lore_Test/adfa');

      // Then: url is the true composed grouping key and the id is carried
      expect(mockLore.repositoryInfo).toHaveBeenCalledWith(
        { repositoryPath: '/Users/alex/Lore_Test/adfa' },
        {}
      );
      expect(identity).toEqual({
        url: 'lore://127.0.0.1/demo-project',
        loreRepositoryId: '019f6e08-1234-4abc-8def-0123456789ab',
      });
    });

    it('collapses duplicate slashes between a trailing-slash remoteUrl and name', async () => {
      // Given: the server url arrives with a trailing slash
      mockLore.repositoryInfo.mockReturnValue(
        fluentMock({
          events: [repositoryDataEvent({ remoteUrl: 'lore://127.0.0.1/', name: 'demo', id: 'x' })],
        }) as never
      );

      // When: resolving
      const identity = await service.resolveRepositoryIdentity('/repo');

      // Then: the composed url has exactly one separator
      expect(identity?.url).toBe('lore://127.0.0.1/demo');
    });

    it('omits loreRepositoryId when the event carries no id', async () => {
      // Given: REPOSITORY_DATA has a url and name but a blank id
      mockLore.repositoryInfo.mockReturnValue(
        fluentMock({
          events: [repositoryDataEvent({ remoteUrl: 'lore://host', name: 'r', id: '' })],
        }) as never
      );

      // When: resolving
      const identity = await service.resolveRepositoryIdentity('/repo');

      // Then: url resolves but no id field is present
      expect(identity).toEqual({ url: 'lore://host/r' });
    });

    it('returns undefined when the event lacks a usable url or name', async () => {
      // Given: REPOSITORY_DATA is missing remoteUrl
      mockLore.repositoryInfo.mockReturnValue(
        fluentMock({
          events: [repositoryDataEvent({ remoteUrl: '', name: 'r', id: 'y' })],
        }) as never
      );

      // When: resolving
      const identity = await service.resolveRepositoryIdentity('/repo');

      // Then: there is nothing truthful to record
      expect(identity).toBeUndefined();
    });

    it('throws LoreOperationError when the SDK fails (caller decides to degrade)', async () => {
      // Given: the SDK rejects
      mockLore.repositoryInfo.mockReturnValue(
        fluentMock({ error: loreError(1, 'No repository at path') }) as never
      );

      // When/Then: resolution surfaces the failure for the caller to handle
      await expect(service.resolveRepositoryIdentity('/repo')).rejects.toThrow(LoreOperationError);
    });
  });

  describe('listRemoteRepositories', () => {
    it('should list repositories from the given server address', async () => {
      // Given: the SDK streams repository list entries
      mockLore.repositoryList.mockReturnValue(
        fluentMock({
          events: [
            { tag: LoreEventTag.REPOSITORY_LIST_ENTRY, data: { id: '1', name: 'RepoA' } },
            { tag: LoreEventTag.REPOSITORY_LIST_ENTRY, data: { id: '2', name: 'RepoB' } },
          ],
        }) as never
      );

      // When: listing remote repositories for a user-provided server
      const repos = await service.listRemoteRepositories('lore.example.com');

      // Then: the server address is passed to the SDK and URLs are derived from it
      expect(mockLore.repositoryList).toHaveBeenCalledWith({}, { url: 'lore.example.com' });
      expect(repos).toEqual([
        { name: 'RepoA', url: 'lore.example.com/RepoA' },
        { name: 'RepoB', url: 'lore.example.com/RepoB' },
      ]);
    });

    it('should preserve the URL scheme of the server address', async () => {
      // Given: the SDK streams one repository entry
      mockLore.repositoryList.mockReturnValue(
        fluentMock({
          events: [{ tag: LoreEventTag.REPOSITORY_LIST_ENTRY, data: { id: '1', name: 'RepoA' } }],
        }) as never
      );

      // When: listing from a plaintext local server address with a scheme
      const repos = await service.listRemoteRepositories('lore://127.0.0.1:41337');

      // Then: the scheme survives into the SDK call and derived repo URLs
      expect(mockLore.repositoryList).toHaveBeenCalledWith({}, { url: 'lore://127.0.0.1:41337' });
      expect(repos).toEqual([{ name: 'RepoA', url: 'lore://127.0.0.1:41337/RepoA' }]);
    });

    it('should strip a repository path but keep the scheme and host', async () => {
      // Given: the SDK streams no entries
      mockLore.repositoryList.mockReturnValue(fluentMock() as never);

      // When: listing with a path accidentally included
      await service.listRemoteRepositories('lores://lore.example.com/SomeRepo');

      // Then: only the scheme and host reach the SDK
      expect(mockLore.repositoryList).toHaveBeenCalledWith({}, { url: 'lores://lore.example.com' });
    });

    it('should reject an empty server address', async () => {
      // When: listing with an empty server address
      const promise = service.listRemoteRepositories('');

      // Then: it should throw without calling the SDK
      await expect(promise).rejects.toThrow('No server address provided');
      expect(mockLore.repositoryList).not.toHaveBeenCalled();
    });
  });

  describe('getFileStatus', () => {
    it('should group status file events into staged, untracked, and unstaged', async () => {
      // Given: the SDK streams one staged, one untracked, and one modified file
      mockLore.repositoryStatus.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.REPOSITORY_STATUS_FILE,
              data: {
                path: 'staged.txt',
                action: LoreFileAction.ADD,
                type: LoreNodeType.FILE,
                flagStaged: true,
                flagDirty: false,
              },
            },
            {
              tag: LoreEventTag.REPOSITORY_STATUS_FILE,
              data: {
                path: 'untracked.txt',
                action: LoreFileAction.ADD,
                type: LoreNodeType.FILE,
                flagStaged: false,
                flagDirty: true,
              },
            },
            {
              tag: LoreEventTag.REPOSITORY_STATUS_FILE,
              data: {
                path: 'modified.txt',
                action: LoreFileAction.KEEP,
                type: LoreNodeType.FILE,
                flagStaged: false,
                flagDirty: true,
              },
            },
            {
              tag: LoreEventTag.REPOSITORY_STATUS_FILE,
              data: {
                path: 'some-dir',
                action: LoreFileAction.ADD,
                type: LoreNodeType.DIRECTORY,
                flagStaged: false,
                flagDirty: true,
              },
            },
          ],
        }) as never
      );

      // When: getting file status
      const status = await service.getFileStatus('/path/to/repo');

      // Then: files are grouped, directory nodes are excluded, and none of
      // these files carry any conflict flags from the SDK
      const noConflict = {
        conflict: false,
        conflictUnresolved: false,
        conflictAutomerged: false,
        conflictMine: false,
        conflictTheirs: false,
      };
      expect(status.staged).toEqual([
        { path: 'staged.txt', isUntracked: true, isStaged: true, ...noConflict },
      ]);
      expect(status.untracked).toEqual([
        { path: 'untracked.txt', isUntracked: true, isStaged: false, ...noConflict },
      ]);
      expect(status.unstaged).toEqual([
        { path: 'modified.txt', isUntracked: false, isStaged: false, ...noConflict },
      ]);
    });

    it('should surface an unresolved conflict on a merge-conflicted file', async () => {
      // Given: the SDK streams a file conflicted by a merge, not yet resolved
      mockLore.repositoryStatus.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.REPOSITORY_STATUS_FILE,
              data: {
                path: 'conflicted.txt',
                action: LoreFileAction.KEEP,
                type: LoreNodeType.FILE,
                flagStaged: false,
                flagDirty: true,
                flagConflict: true,
                flagConflictUnresolved: true,
                flagConflictAutomerged: false,
                flagConflictMine: false,
                flagConflictTheirs: false,
              },
            },
          ],
        }) as never
      );

      // When: getting file status
      const status = await service.getFileStatus('/path/to/repo');

      // Then: the conflict and unresolved flags are surfaced true
      expect(status.unstaged).toEqual([
        {
          path: 'conflicted.txt',
          isUntracked: false,
          isStaged: false,
          conflict: true,
          conflictUnresolved: true,
          conflictAutomerged: false,
          conflictMine: false,
          conflictTheirs: false,
        },
      ]);
    });

    it('should surface an automerged file without marking it unresolved', async () => {
      // Given: the SDK streams a file the merge resolved automatically
      mockLore.repositoryStatus.mockReturnValue(
        fluentMock({
          events: [
            {
              tag: LoreEventTag.REPOSITORY_STATUS_FILE,
              data: {
                path: 'automerged.txt',
                action: LoreFileAction.KEEP,
                type: LoreNodeType.FILE,
                flagStaged: false,
                flagDirty: true,
                flagConflict: true,
                flagConflictUnresolved: false,
                flagConflictAutomerged: true,
                flagConflictMine: false,
                flagConflictTheirs: false,
              },
            },
          ],
        }) as never
      );

      // When: getting file status
      const status = await service.getFileStatus('/path/to/repo');

      // Then: conflict + automerged are true, unresolved is false
      expect(status.unstaged).toEqual([
        {
          path: 'automerged.txt',
          isUntracked: false,
          isStaged: false,
          conflict: true,
          conflictUnresolved: false,
          conflictAutomerged: true,
          conflictMine: false,
          conflictTheirs: false,
        },
      ]);
    });

    it.each([['mine', 'conflictMine'] as const, ['theirs', 'conflictTheirs'] as const])(
      'should surface a conflict resolved as %s',
      async (resolution, field) => {
        // Given: the SDK streams a file resolved by picking one side
        mockLore.repositoryStatus.mockReturnValue(
          fluentMock({
            events: [
              {
                tag: LoreEventTag.REPOSITORY_STATUS_FILE,
                data: {
                  path: 'resolved.txt',
                  action: LoreFileAction.KEEP,
                  type: LoreNodeType.FILE,
                  flagStaged: false,
                  flagDirty: true,
                  flagConflict: true,
                  flagConflictUnresolved: false,
                  flagConflictAutomerged: false,
                  flagConflictMine: resolution === 'mine',
                  flagConflictTheirs: resolution === 'theirs',
                },
              },
            ],
          }) as never
        );

        // When: getting file status
        const status = await service.getFileStatus('/path/to/repo');

        // Then: only the chosen side's resolution flag is true
        expect(status.unstaged).toEqual([
          {
            path: 'resolved.txt',
            isUntracked: false,
            isStaged: false,
            conflict: true,
            conflictUnresolved: false,
            conflictAutomerged: false,
            conflictMine: field === 'conflictMine',
            conflictTheirs: field === 'conflictTheirs',
          },
        ]);
      }
    );
  });

  describe('stageFiles / unstageFiles', () => {
    it('should pass paths through to the SDK', async () => {
      // Given: the SDK resolves
      mockLore.fileStage.mockReturnValue(fluentMock() as never);
      mockLore.fileUnstage.mockReturnValue(fluentMock() as never);

      // When: staging and unstaging
      await service.stageFiles('/path/to/repo', ['a.txt', 'b.txt']);
      await service.unstageFiles('/path/to/repo', ['a.txt']);

      // Then: args match the SDK contract
      expect(mockLore.fileStage).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { paths: ['a.txt', 'b.txt'] }
      );
      expect(mockLore.fileUnstage).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { paths: ['a.txt'] }
      );
    });
  });

  describe('commit', () => {
    it('should commit without pushing', async () => {
      // Given: the commit resolves
      mockLore.revisionCommit.mockReturnValue(fluentMock() as never);

      // When: committing
      await service.commit('/path/to/repo', 'My commit message');

      // Then: only revisionCommit is called, addressed via globals
      expect(mockLore.revisionCommit).toHaveBeenCalledWith(
        { repositoryPath: '/path/to/repo' },
        { message: 'My commit message' }
      );
      expect(mockLore.branchPush).not.toHaveBeenCalled();
    });

    it('should throw LoreOperationError when the commit fails', async () => {
      // Given: the commit fails
      mockLore.revisionCommit.mockReturnValue(
        fluentMock({ error: loreError(7, 'Nothing staged') }) as never
      );

      // When: committing
      const promise = service.commit('/path/to/repo', 'My commit message');

      // Then: the commit error propagates and push is never attempted
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow('Failed to commit changes');
      expect(mockLore.branchPush).not.toHaveBeenCalled();
    });
  });

  describe('push', () => {
    it('should push without committing', async () => {
      // Given: the push resolves
      mockLore.branchPush.mockReturnValue(fluentMock() as never);

      // When: pushing
      await service.push('/path/to/repo');

      // Then: only branchPush is called, addressed via globals
      expect(mockLore.branchPush).toHaveBeenCalledWith({ repositoryPath: '/path/to/repo' }, {});
      expect(mockLore.revisionCommit).not.toHaveBeenCalled();
    });

    it('should throw LoreOperationError when the push fails', async () => {
      // Given: the push fails
      mockLore.branchPush.mockReturnValue(
        fluentMock({ error: loreError(8, 'Remote rejected push') }) as never
      );

      // When: pushing
      const promise = service.push('/path/to/repo');

      // Then: the push error propagates
      await expect(promise).rejects.toThrow(LoreOperationError);
      await expect(promise).rejects.toThrow('Failed to push changes');
    });
  });

  describe('checkRepositoryStatus', () => {
    const fsSync = jest.requireActual<typeof import('node:fs')>('node:fs');
    const os = jest.requireActual<typeof import('node:os')>('node:os');
    const nodePath = jest.requireActual<typeof import('node:path')>('node:path');
    let tempDir: string;

    beforeEach(() => {
      tempDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'lore-repo-status-'));
    });

    afterEach(() => {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should recognize a working copy with a .lore marker', async () => {
      // Given: a directory with a .lore marker
      fsSync.mkdirSync(nodePath.join(tempDir, '.lore'));

      // When: checking the status
      const status = await service.checkRepositoryStatus(tempDir);

      // Then: it is an existing Lore repository
      expect(status).toEqual({ exists: true, isLoreRepo: true });
    });

    it('should not recognize a directory with only a foreign VCS marker', async () => {
      // Given: a directory marked by a different VCS
      fsSync.mkdirSync(nodePath.join(tempDir, '.git'));

      // When: checking the status
      const status = await service.checkRepositoryStatus(tempDir);

      // Then: it exists but is not a Lore repository
      expect(status).toEqual({ exists: true, isLoreRepo: false });
    });

    it('should report a plain directory as existing but not a repository', async () => {
      // When: checking an unmarked directory
      const status = await service.checkRepositoryStatus(tempDir);

      // Then: it exists but is not a repository
      expect(status).toEqual({ exists: true, isLoreRepo: false });
    });

    it('should report a missing path as non-existent', async () => {
      // When: checking a path that does not exist
      const status = await service.checkRepositoryStatus(nodePath.join(tempDir, 'missing'));

      // Then: nothing exists there
      expect(status).toEqual({ exists: false, isLoreRepo: false });
    });

    it('should report a file path as existing but not a repository', async () => {
      // Given: a file rather than a directory
      const filePath = nodePath.join(tempDir, 'file.txt');
      fsSync.writeFileSync(filePath, 'contents');

      // When: checking the status
      const status = await service.checkRepositoryStatus(filePath);

      // Then: it exists but is not a repository
      expect(status).toEqual({ exists: true, isLoreRepo: false });
    });
  });
});

// The subscribe callback outlives waitAsync: the SDK resolves the subscribe
// call as soon as the server acknowledges it, then keeps delivering push
// notifications through the same callback until unsubscribe (verified
// against a live server).
describe('LoreRepositoryService notification subscriptions', () => {
  let service: LoreRepositoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LoreRepositoryService();
  });

  function fireOn(chain: unknown, tag: number, data: Record<string, unknown>): void {
    (chain as { registeredCallback?: (event: unknown) => void }).registeredCallback?.({
      tag,
      data,
      clone: () => ({ tag, data }),
    });
  }

  it('emits a notification carrying userId when a branch-pushed event arrives after subscribe resolved', async () => {
    // Given: a subscription whose SDK call resolves immediately
    const chain = fluentMock({
      events: [{ tag: LoreEventTag.NOTIFICATION_SUBSCRIBED, data: { repository: 'repo-id' } }],
    });
    mockLore.notificationSubscribe.mockReturnValue(chain as never);
    const received: unknown[] = [];
    service.on('notification', payload => received.push(payload));

    // When: subscribing, then a push notification arrives later on the
    // still-registered callback
    await service.subscribeNotifications('/repos/a');
    expect(received).toEqual([]);
    fireOn(chain, LoreEventTag.NOTIFICATION_BRANCH_PUSHED, {
      revision: 'abc',
      revisionNumber: 24,
      branch: 'branch-id',
      userId: 'user',
    });

    // Then: the pushing user's id is no longer discarded (P1 finding c —
    // attribution ships on this userId)
    expect(received).toEqual([
      { repositoryPath: '/repos/a', kind: 'branchPushed', userId: 'user' },
    ]);
  });

  it('maps branch-created and branch-deleted events to their kinds', async () => {
    // Given: an active subscription
    const chain = fluentMock();
    mockLore.notificationSubscribe.mockReturnValue(chain as never);
    const kinds: unknown[] = [];
    service.on('notification', payload => kinds.push((payload as { kind: string }).kind));
    await service.subscribeNotifications('/repos/a');

    // When: created and deleted notifications arrive
    fireOn(chain, LoreEventTag.NOTIFICATION_BRANCH_CREATED, { branch: 'branch-id' });
    fireOn(chain, LoreEventTag.NOTIFICATION_BRANCH_DELETED, { branch: 'branch-id' });

    // Then: both kinds come through in order
    expect(kinds).toEqual(['branchCreated', 'branchDeleted']);
  });

  it('maps resource-locked and resource-unlocked events with their userId/branch/paths', async () => {
    // Given: an active subscription
    const chain = fluentMock();
    mockLore.notificationSubscribe.mockReturnValue(chain as never);
    const received: unknown[] = [];
    service.on('notification', payload => received.push(payload));
    await service.subscribeNotifications('/repos/a');

    // When: lock and unlock notifications arrive
    fireOn(chain, LoreEventTag.NOTIFICATION_RESOURCE_LOCKED, {
      userId: 'user-1',
      branch: 'main',
      paths: ['a.txt', 'b.txt'],
    });
    fireOn(chain, LoreEventTag.NOTIFICATION_RESOURCE_UNLOCKED, {
      userId: 'user-1',
      branch: 'main',
      paths: ['a.txt'],
    });

    // Then: both carry their full payload
    expect(received).toEqual([
      {
        repositoryPath: '/repos/a',
        kind: 'resourceLocked',
        userId: 'user-1',
        branch: 'main',
        paths: ['a.txt', 'b.txt'],
      },
      {
        repositoryPath: '/repos/a',
        kind: 'resourceUnlocked',
        userId: 'user-1',
        branch: 'main',
        paths: ['a.txt'],
      },
    ]);
  });

  it('maps a resource-locked event with an empty paths array', async () => {
    // Given: an active subscription
    const chain = fluentMock();
    mockLore.notificationSubscribe.mockReturnValue(chain as never);
    const received: unknown[] = [];
    service.on('notification', payload => received.push(payload));
    await service.subscribeNotifications('/repos/a');

    // When: a lock notification arrives with no paths
    fireOn(chain, LoreEventTag.NOTIFICATION_RESOURCE_LOCKED, {
      userId: 'user-1',
      branch: 'main',
      paths: [],
    });

    // Then: the empty array is preserved, not dropped or defaulted away
    expect(received).toEqual([
      {
        repositoryPath: '/repos/a',
        kind: 'resourceLocked',
        userId: 'user-1',
        branch: 'main',
        paths: [],
      },
    ]);
  });

  it('subscribes a repository path only once', async () => {
    // Given: a first subscription is active
    mockLore.notificationSubscribe.mockReturnValue(fluentMock() as never);
    await service.subscribeNotifications('/repos/a');

    // When: subscribing the same path again
    await service.subscribeNotifications('/repos/a');

    // Then: the SDK was only called once
    expect(mockLore.notificationSubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes through the SDK and allows a later resubscribe', async () => {
    // Given: an active subscription
    mockLore.notificationSubscribe.mockReturnValue(fluentMock() as never);
    mockLore.notificationUnsubscribe.mockReturnValue(fluentMock() as never);
    await service.subscribeNotifications('/repos/a');

    // When: unsubscribing, then subscribing again
    await service.unsubscribeNotifications('/repos/a');
    await service.subscribeNotifications('/repos/a');

    // Then: the SDK saw the unsubscribe and a fresh subscribe
    expect(mockLore.notificationUnsubscribe).toHaveBeenCalledWith(
      { repositoryPath: '/repos/a' },
      {}
    );
    expect(mockLore.notificationSubscribe).toHaveBeenCalledTimes(2);
  });

  it('ignores an unsubscribe for a path that was never subscribed', async () => {
    // When: unsubscribing without a prior subscribe
    await service.unsubscribeNotifications('/repos/a');

    // Then: no SDK call is made
    expect(mockLore.notificationUnsubscribe).not.toHaveBeenCalled();
  });

  it('throws a LoreOperationError and forgets the path when subscribe fails', async () => {
    // Given: the SDK rejects the subscribe
    mockLore.notificationSubscribe.mockReturnValue(
      fluentMock({ error: loreError(7, 'no server') }) as never
    );

    // When/Then: the failure is wrapped
    await expect(service.subscribeNotifications('/repos/a')).rejects.toThrow(LoreOperationError);

    // And: a retry reaches the SDK again rather than being deduped
    mockLore.notificationSubscribe.mockReturnValue(fluentMock() as never);
    await service.subscribeNotifications('/repos/a');
    expect(mockLore.notificationSubscribe).toHaveBeenCalledTimes(2);
  });
});

// P1 finding c: authUserInfo/authLocalUserInfo are the only identity
// sources, and both fail offline ("No auth endpoint available"). Name
// resolution must be strictly best-effort: never throw, cache a success,
// and fall back to the raw userId when both attempts fail.
describe('LoreRepositoryService resolveUserName', () => {
  let service: LoreRepositoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LoreRepositoryService();
  });

  function authInfoEvent(id: string, name: string): MockEvent {
    return { tag: LoreEventTag.AUTH_USER_INFO, data: { id, name } };
  }

  it('resolves via authUserInfo (remote hit) without falling back to authLocalUserInfo', async () => {
    // Given: authUserInfo resolves the user
    mockLore.authUserInfo.mockReturnValue(
      fluentMock({ events: [authInfoEvent('user-1', 'Mara Voss')] }) as never
    );

    // When: resolving the name
    const name = await service.resolveUserName('/repos/a', 'user-1');

    // Then: the remote name is used and the local fallback is never tried
    expect(name).toBe('Mara Voss');
    expect(mockLore.authUserInfo).toHaveBeenCalledWith(
      { repositoryPath: '/repos/a' },
      { userIds: ['user-1'] }
    );
    expect(mockLore.authLocalUserInfo).not.toHaveBeenCalled();
  });

  it('falls back to authLocalUserInfo when authUserInfo throws (offline)', async () => {
    // Given: authUserInfo fails offline, authLocalUserInfo resolves locally
    mockLore.authUserInfo.mockReturnValue(
      fluentMock({ error: loreError(6, 'No auth endpoint available') }) as never
    );
    mockLore.authLocalUserInfo.mockReturnValue(
      fluentMock({ events: [authInfoEvent('user-1', 'Mara Voss')] }) as never
    );

    // When: resolving the name
    const name = await service.resolveUserName('/repos/a', 'user-1');

    // Then: the local fallback provides the name
    expect(name).toBe('Mara Voss');
    expect(mockLore.authLocalUserInfo).toHaveBeenCalledWith(
      { repositoryPath: '/repos/a' },
      { userIds: ['user-1'] }
    );
  });

  it('falls back to authLocalUserInfo when authUserInfo resolves with no matching entry', async () => {
    // Given: authUserInfo succeeds but streams nothing for this user
    mockLore.authUserInfo.mockReturnValue(fluentMock() as never);
    mockLore.authLocalUserInfo.mockReturnValue(
      fluentMock({ events: [authInfoEvent('user-1', 'Mara Voss')] }) as never
    );

    // When: resolving the name
    const name = await service.resolveUserName('/repos/a', 'user-1');

    // Then: the local fallback provides the name
    expect(name).toBe('Mara Voss');
  });

  it('returns the raw userId when both authUserInfo and authLocalUserInfo fail (miss)', async () => {
    // Given: both identity sources fail, matching P1 finding c offline
    mockLore.authUserInfo.mockReturnValue(
      fluentMock({ error: loreError(6, 'No auth endpoint available') }) as never
    );
    mockLore.authLocalUserInfo.mockReturnValue(
      fluentMock({ error: loreError(6, 'No auth endpoint available') }) as never
    );

    // When: resolving the name
    const name = await service.resolveUserName('/repos/a', 'user-1');

    // Then: the notification is never dropped — the raw id passes through
    expect(name).toBe('user-1');
  });

  it('caches a resolved name and skips the SDK on a repeated lookup', async () => {
    // Given: authUserInfo resolves once
    mockLore.authUserInfo.mockReturnValue(
      fluentMock({ events: [authInfoEvent('user-1', 'Mara Voss')] }) as never
    );

    // When: resolving the same user twice
    const first = await service.resolveUserName('/repos/a', 'user-1');
    const second = await service.resolveUserName('/repos/a', 'user-1');

    // Then: both calls return the cached name, and the SDK is hit once
    expect(first).toBe('Mara Voss');
    expect(second).toBe('Mara Voss');
    expect(mockLore.authUserInfo).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed resolution, retrying the SDK on the next lookup', async () => {
    // Given: both sources fail on the first attempt, then succeed on retry
    mockLore.authUserInfo
      .mockReturnValueOnce(
        fluentMock({ error: loreError(6, 'No auth endpoint available') }) as never
      )
      .mockReturnValueOnce(fluentMock({ events: [authInfoEvent('user-1', 'Mara Voss')] }) as never);
    mockLore.authLocalUserInfo.mockReturnValue(
      fluentMock({ error: loreError(6, 'No auth endpoint available') }) as never
    );

    // When: resolving the same user twice
    const first = await service.resolveUserName('/repos/a', 'user-1');
    const second = await service.resolveUserName('/repos/a', 'user-1');

    // Then: the first lookup degrades to the raw id, the second recovers
    expect(first).toBe('user-1');
    expect(second).toBe('Mara Voss');
    expect(mockLore.authUserInfo).toHaveBeenCalledTimes(2);
  });
});

describe('LoreRepositoryService getCurrentRevision', () => {
  let service: LoreRepositoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LoreRepositoryService();
  });

  it('returns the first entry of an unqualified single-entry history walk', async () => {
    // Given: revisionHistory emits the working copy's revision first
    mockLore.revisionHistory.mockReturnValue(
      fluentMock({
        events: [
          {
            tag: LoreEventTag.REVISION_HISTORY_ENTRY,
            data: { revision: 'workspace-hash', revisionNumber: 12, parent: ['p', ''] },
          },
        ],
      }) as never
    );

    // When: asking for the current revision
    const revision = await service.getCurrentRevision('/repos/a');

    // Then: the walk is unqualified (no branch arg) with length 1
    expect(revision).toBe('workspace-hash');
    expect(mockLore.revisionHistory).toHaveBeenCalledWith(
      { repositoryPath: '/repos/a' },
      { length: 1 }
    );
  });

  it('degrades to an empty string when the walk fails', async () => {
    // Given: the SDK rejects
    mockLore.revisionHistory.mockReturnValue(
      fluentMock({ error: loreError(3, 'db locked') }) as never
    );

    // When/Then: the caller gets an empty string, not a throw — the
    // fingerprint check simply skips this tick
    await expect(service.getCurrentRevision('/repos/a')).resolves.toBe('');
  });
});
