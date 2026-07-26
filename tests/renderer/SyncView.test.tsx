import {
  buildReviewEntryProps,
  buildTransportProps,
  resolveMergeTarget,
} from '../../src/renderer/components/SyncView';
import type { ReviewEntryInputs, TransportInputs } from '../../src/renderer/components/SyncView';
import type { Repository } from '../../src/shared/types';

function baseInputs(overrides: Partial<TransportInputs> = {}): TransportInputs {
  return {
    hasSelection: true,
    showClone: false,
    isBusy: false,
    needsBranchSwitch: false,
    isSyncing: false,
    isCloning: false,
    isCommitting: false,
    isPushing: false,
    stagedCount: 0,
    divergenceState: 'inSync',
    currentRevision: 'hash-tip',
    branchTipRevision: 'hash-tip',
    onSync: jest.fn(),
    onCommit: jest.fn(),
    onPush: jest.fn(),
    onClone: jest.fn(),
    onSyncToRevision: jest.fn(),
    onReset: jest.fn(),
    ...overrides,
  };
}

describe('buildTransportProps sync accent', () => {
  it('accents Sync when the workspace sits on an older revision of an in-sync branch', () => {
    // Given: branch tips agree with the remote, but the workspace was synced
    // to an older revision of the branch
    const inputs = baseInputs({
      divergenceState: 'inSync',
      currentRevision: 'hash-older',
      branchTipRevision: 'hash-tip',
    });

    // When: building the transport props
    const props = buildTransportProps(inputs);

    // Then: Sync is the actionable next step and carries the accent
    expect(props.sync.accented).toBe(true);
    expect(props.sync.sub).toBe('Older revision');
  });

  it('does not accent Sync when the workspace is on the branch tip and in sync', () => {
    // Given: workspace on the tip, branch in sync with the remote
    const inputs = baseInputs();

    // When: building the transport props
    const props = buildTransportProps(inputs);

    // Then: nothing to sync — neutral button with the idle caption
    expect(props.sync.accented).toBe(false);
    expect(props.sync.sub).toBe('Current');
  });

  it('still accents Sync when the branch is behind or diverged from the remote', () => {
    // Given: the remote has moved on
    const inputs = baseInputs({ divergenceState: 'behindOrDiverged' });

    // When: building the transport props
    const props = buildTransportProps(inputs);

    // Then: the existing behind-remote accent is preserved
    expect(props.sync.accented).toBe(true);
    expect(props.sync.sub).toBe('Behind remote');
  });

  it('does not accent Sync while revision data is unavailable', () => {
    // Given: the graph degraded (empty current) or is still loading (no tip)
    const noCurrent = baseInputs({ currentRevision: '' });
    const noTip = baseInputs({ branchTipRevision: '' });

    // When / Then: neither half-known state claims the accent
    expect(buildTransportProps(noCurrent).sync.accented).toBe(false);
    expect(buildTransportProps(noTip).sync.accented).toBe(false);
  });
});

describe('resolveMergeTarget', () => {
  it('prefers the parent lane, then the default branch, then main', () => {
    const branches = [
      { name: 'trunk', isDefault: true, isCurrent: false },
      { name: 'feat/topic', isDefault: false, isCurrent: true },
    ];

    // When/Then: parent lane wins; without one the default branch; bare 'main' last
    expect(resolveMergeTarget('release/1.0', branches)).toBe('release/1.0');
    expect(resolveMergeTarget(undefined, branches)).toBe('trunk');
    expect(resolveMergeTarget(undefined, [])).toBe('main');
  });
});

describe('buildReviewEntryProps', () => {
  const repository = {
    id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
    name: 'My Repo',
    url: 'lore.example.com/MyRepo',
    localPath: '/repos/my-repo',
    accentHue: 74,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  } as Repository;

  function baseEntryInputs(overrides: Partial<ReviewEntryInputs> = {}): ReviewEntryInputs {
    return {
      selectedRepo: repository,
      showClone: false,
      branchName: 'feat/topic',
      currentRevision: 'r128',
      mergeTarget: 'main',
      dirtyFileCount: 2,
      hasRevisionsToLand: true,
      openProjectView: jest.fn(),
      ...overrides,
    };
  }

  it('offers Review and Merge when files are dirty and the branch has work to land', () => {
    // When: building the entry props on a dirty feature branch ahead of main
    const entry = buildReviewEntryProps(baseEntryInputs());

    // Then: both entry points are offered
    expect(entry.onReview).toBeDefined();
    expect(entry.onMerge).toBeDefined();
  });

  it('withholds Review while the working set is clean', () => {
    // When: building with no dirty files
    const entry = buildReviewEntryProps(baseEntryInputs({ dirtyFileCount: 0 }));

    // Then: there is nothing to review — no Review entry; Merge is unaffected
    expect(entry.onReview).toBeUndefined();
    expect(entry.onMerge).toBeDefined();
  });

  it('withholds Merge when the branch has nothing the target lacks', () => {
    // When: building with the land predicate false (in sync, or already
    // landed — by this app or another client)
    const entry = buildReviewEntryProps(baseEntryInputs({ hasRevisionsToLand: false }));

    // Then: no Merge entry that would land nothing; Review is unaffected
    expect(entry.onMerge).toBeUndefined();
    expect(entry.onReview).toBeDefined();
  });

  it('withholds Merge when the merge target IS the current branch', () => {
    // When: building on main itself, even if the predicate were true
    const entry = buildReviewEntryProps(
      baseEntryInputs({ branchName: 'main', mergeTarget: 'main' })
    );

    // Then: Merge is withheld — it would merge main into main
    expect(entry.onMerge).toBeUndefined();
  });

  it('offers nothing while no repository is selected or the clone is pending', () => {
    // When: building with no selection, and with a pending clone
    const noRepo = buildReviewEntryProps(baseEntryInputs({ selectedRepo: null }));
    const clonePending = buildReviewEntryProps(baseEntryInputs({ showClone: true }));

    // Then: neither state offers an entry point
    expect(noRepo).toEqual({});
    expect(clonePending).toEqual({});
  });

  it('opens the merge workflow toward the resolved target', () => {
    // Given: an observable opener callback
    const openProjectView = jest.fn();

    // When: opening the merge workflow
    buildReviewEntryProps(baseEntryInputs({ mergeTarget: 'trunk', openProjectView })).onMerge?.();

    // Then: the built request targets the resolved branch's head
    expect(openProjectView).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'merge',
        compare: {
          source: { kind: 'branchHead', branch: 'feat/topic' },
          target: { kind: 'branchHead', branch: 'trunk' },
        },
      })
    );
  });

  it('opens the commit workflow over the selected repository', () => {
    // Given: an observable opener callback
    const openProjectView = jest.fn();

    // When: opening the review (commit) workflow
    buildReviewEntryProps(baseEntryInputs({ openProjectView })).onReview?.();

    // Then: the built request addresses the repository by path with the
    // commit compare preloaded
    expect(openProjectView).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryPath: '/repos/my-repo',
        branchName: 'feat/topic',
        workflow: 'commit',
        compare: {
          source: { kind: 'revision', revision: 'r128' },
          target: { kind: 'workingTree' },
        },
      })
    );
  });
});
