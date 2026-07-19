import { buildTransportProps } from '../../src/renderer/components/SyncView';
import type { TransportInputs } from '../../src/renderer/components/SyncView';

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
