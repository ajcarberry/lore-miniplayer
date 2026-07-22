import { computeActionSignals, isWorkspaceBehindTip } from '../../src/renderer/utils/actionSignals';

describe('isWorkspaceBehindTip', () => {
  it('is true only when both hashes are known and differ', () => {
    // Given/When/Then: known differing hashes flag the workspace as behind
    expect(isWorkspaceBehindTip('hash-older', 'hash-tip')).toBe(true);
    expect(isWorkspaceBehindTip('hash-tip', 'hash-tip')).toBe(false);
    // And: a loading or degraded side makes no claim
    expect(isWorkspaceBehindTip('', 'hash-tip')).toBe(false);
    expect(isWorkspaceBehindTip('hash-older', '')).toBe(false);
  });
});

describe('computeActionSignals', () => {
  it('raises syncNeeded when the branch is behind or diverged from the remote', () => {
    // Given: the remote has moved on
    const signals = computeActionSignals({
      divergenceState: 'behindOrDiverged',
      currentRevision: 'tip',
      branchTipRevision: 'tip',
      dirtyCount: 0,
    });

    // Then: only the sync signal is active
    expect(signals).toEqual({ syncNeeded: true, uncommitted: false, unpushed: false });
  });

  it('raises syncNeeded when the workspace sits below the branch tip of an in-sync branch', () => {
    // Given: tips agree with the remote but the workspace was synced older
    const signals = computeActionSignals({
      divergenceState: 'inSync',
      currentRevision: 'older',
      branchTipRevision: 'tip',
      dirtyCount: 0,
    });

    // Then: sync is still the actionable next step
    expect(signals.syncNeeded).toBe(true);
  });

  it('raises uncommitted for any dirty file, staged or not', () => {
    // Given: one dirty file in the working set
    const signals = computeActionSignals({
      divergenceState: 'inSync',
      currentRevision: 'tip',
      branchTipRevision: 'tip',
      dirtyCount: 1,
    });

    // Then: the commit signal is active
    expect(signals).toEqual({ syncNeeded: false, uncommitted: true, unpushed: false });
  });

  it('raises unpushed when local commits are ahead of the remote', () => {
    // Given: local history has moved past the remote tip
    const signals = computeActionSignals({
      divergenceState: 'ahead',
      currentRevision: 'tip',
      branchTipRevision: 'tip',
      dirtyCount: 0,
    });

    // Then: the push signal is active
    expect(signals).toEqual({ syncNeeded: false, uncommitted: false, unpushed: true });
  });

  it('raises nothing when all clear or state is unknown', () => {
    // Given: a clean, in-sync workspace on the tip
    const clear = computeActionSignals({
      divergenceState: 'inSync',
      currentRevision: 'tip',
      branchTipRevision: 'tip',
      dirtyCount: 0,
    });
    // And: no divergence data at all
    const unknown = computeActionSignals({
      divergenceState: undefined,
      currentRevision: '',
      branchTipRevision: '',
      dirtyCount: 0,
    });

    // Then: a quiet pill in both cases
    expect(clear).toEqual({ syncNeeded: false, uncommitted: false, unpushed: false });
    expect(unknown).toEqual({ syncNeeded: false, uncommitted: false, unpushed: false });
  });
});
