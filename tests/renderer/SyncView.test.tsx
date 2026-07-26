import { buildReviewEntryProps, buildTransportProps } from '../../src/renderer/components/SyncView';
import type { ReviewEntryInputs, TransportInputs } from '../../src/renderer/components/SyncView';
import { installMockElectronAPI } from '../mocks/electron-api';
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
      parentLaneName: 'main',
      branches: [
        { name: 'main', isDefault: true, isCurrent: false },
        { name: 'feat/topic', isDefault: false, isCurrent: true },
      ],
      ...overrides,
    };
  }

  it('offers Review and Merge when the branch has a distinct parent-lane target', () => {
    // When: building the entry props on a feature branch forked from main
    const entry = buildReviewEntryProps(baseEntryInputs());

    // Then: both entry points are offered
    expect(entry.onReview).toBeDefined();
    expect(entry.onMerge).toBeDefined();
  });

  it('withholds Merge when the merge target IS the current branch', () => {
    // When: building the entry props on main itself (parent lane absent, main
    // is the default branch)
    const entry = buildReviewEntryProps(
      baseEntryInputs({ branchName: 'main', parentLaneName: undefined })
    );

    // Then: Review stays, Merge is withheld — it would merge main into main
    expect(entry.onReview).toBeDefined();
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

  it('falls back to the default branch as the merge target when no parent lane resolved', () => {
    // Given: the review bridge is observable
    installMockElectronAPI();
    const open = jest.fn();
    Object.assign(window.electronAPI, { review: { open } });

    // When: opening the merge workflow with no parent lane
    const entry = buildReviewEntryProps(baseEntryInputs({ parentLaneName: undefined }));
    entry.onMerge?.();

    // Then: the request targets the default branch's head
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'merge',
        compare: {
          source: { kind: 'branchHead', branch: 'feat/topic' },
          target: { kind: 'branchHead', branch: 'main' },
        },
      })
    );
  });

  it('opens the commit workflow over the selected repository', () => {
    // Given: the review bridge is observable
    installMockElectronAPI();
    const open = jest.fn();
    Object.assign(window.electronAPI, { review: { open } });

    // When: opening the review (commit) workflow
    buildReviewEntryProps(baseEntryInputs()).onReview?.();

    // Then: the request addresses the repository by path with the commit
    // compare preloaded
    expect(open).toHaveBeenCalledWith(
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
