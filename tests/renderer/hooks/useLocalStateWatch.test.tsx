import { act, renderHook } from '@testing-library/react';
import { useLocalStateWatch } from '../../../src/renderer/hooks/useLocalStateWatch';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeRepository } from '../../mocks/repository-fixture';

const repoA = makeRepository({
  name: 'Repo A',
  url: 'lore.example.com/RepoA',
  localPath: '/repos/a',
});

function mockRevisions(...hashes: (string | null)[]): void {
  const mock = window.electronAPI.lore.currentRevision as jest.Mock;
  mock.mockReset();
  for (const hash of hashes) {
    if (hash === null) {
      mock.mockResolvedValueOnce({ success: false, error: 'db locked' });
    } else {
      mock.mockResolvedValueOnce({ success: true, data: hash });
    }
  }
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('useLocalStateWatch', () => {
  beforeEach(() => {
    installMockElectronAPI();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires when the workspace revision changes between ticks', async () => {
    // Given: the workspace moves to a new revision after the baseline tick
    mockRevisions('hash-1', 'hash-2');
    const onChange = jest.fn();
    renderHook(() => useLocalStateWatch(repoA, true, onChange));
    await elapse(0);

    // When: the next tick observes the new hash
    await elapse(3000);

    // Then: the change callback fires exactly once
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while the revision is unchanged', async () => {
    // Given: a stable workspace across several ticks
    mockRevisions('hash-1', 'hash-1', 'hash-1');
    const onChange = jest.fn();
    renderHook(() => useLocalStateWatch(repoA, true, onChange));
    await elapse(0);

    // When: two more ticks elapse
    await elapse(3000);
    await elapse(3000);

    // Then: no change is reported (the baseline tick never fires either)
    expect(onChange).not.toHaveBeenCalled();
  });

  it('skips failed and empty ticks without losing the baseline', async () => {
    // Given: a failed tick and an empty degrade between two real hashes
    mockRevisions('hash-1', null, '', 'hash-2');
    const onChange = jest.fn();
    renderHook(() => useLocalStateWatch(repoA, true, onChange));
    await elapse(0);

    // When: the failing ticks pass, then the real change lands
    await elapse(3000);
    await elapse(3000);
    expect(onChange).not.toHaveBeenCalled();
    await elapse(3000);

    // Then: the change is still detected against the original baseline
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not poll while disconnected or without a selection', async () => {
    // When: mounting disconnected and with no repo
    renderHook(() => useLocalStateWatch(repoA, false, jest.fn()));
    renderHook(() => useLocalStateWatch(null, true, jest.fn()));
    await elapse(3000);

    // Then: the fingerprint is never fetched
    expect(window.electronAPI.lore.currentRevision).not.toHaveBeenCalled();
  });

  it('rebaselines when the selected repository changes', async () => {
    // Given: repo A settles a baseline
    mockRevisions('hash-a', 'hash-b1', 'hash-b1');
    const onChange = jest.fn();
    const { rerender } = renderHook(({ repo }) => useLocalStateWatch(repo, true, onChange), {
      initialProps: { repo: repoA },
    });
    await elapse(0);

    // When: switching to repo B whose hash differs from A's
    const repoB = makeRepository({
      id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
      name: 'Repo B',
      localPath: '/repos/b',
    });
    rerender({ repo: repoB });
    await elapse(0);
    await elapse(3000);

    // Then: the differing hash is a fresh baseline, not a change
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops polling on unmount', async () => {
    // Given: a mounted watcher
    mockRevisions('hash-1', 'hash-1', 'hash-1');
    const { unmount } = renderHook(() => useLocalStateWatch(repoA, true, jest.fn()));
    await elapse(0);
    const callsBefore = (window.electronAPI.lore.currentRevision as jest.Mock).mock.calls.length;

    // When: unmounting and letting time pass
    unmount();
    await elapse(9000);

    // Then: no further fetches happen
    expect(window.electronAPI.lore.currentRevision).toHaveBeenCalledTimes(callsBefore);
  });
});
