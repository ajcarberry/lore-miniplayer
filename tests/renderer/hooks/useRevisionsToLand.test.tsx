jest.mock('../../../src/renderer/utils/logging', () => ({
  logError: jest.fn(),
}));

import { renderHook, waitFor } from '@testing-library/react';
import { useRevisionsToLand } from '../../../src/renderer/hooks/useRevisionsToLand';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeRepository } from '../../mocks/repository-fixture';

const repoA = makeRepository({
  name: 'Repo A',
  url: 'lore.example.com/RepoA',
  localPath: '/repos/a',
});

describe('useRevisionsToLand', () => {
  beforeEach(() => {
    installMockElectronAPI();
  });

  it('asks whether the branch carries revisions the target lacks', async () => {
    // Given: the bridge reports work to land
    (window.electronAPI.lore.revisionsToLand as jest.Mock).mockResolvedValue({
      success: true,
      data: true,
    });

    // When: the hook mounts for a feature branch with a distinct target
    const { result } = renderHook(() =>
      useRevisionsToLand(repoA, 'feat/topic', 'main', true, 'tip-1')
    );

    // Then: it resolves true through the merge service's own predicate
    await waitFor(() => expect(result.current.hasRevisionsToLand).toBe(true));
    expect(window.electronAPI.lore.revisionsToLand).toHaveBeenCalledWith({
      repositoryPath: '/repos/a',
      sourceBranch: 'feat/topic',
      targetBranch: 'main',
    });
  });

  it('reads false while loading and after a failed fetch', async () => {
    // Given: the bridge fails
    (window.electronAPI.lore.revisionsToLand as jest.Mock).mockResolvedValue({
      success: false,
      error: 'offline',
    });

    // When: the hook mounts
    const { result } = renderHook(() =>
      useRevisionsToLand(repoA, 'feat/topic', 'main', true, 'tip-1')
    );

    // Then: the answer degrades to false — never a merge offer on unknown state
    expect(result.current.hasRevisionsToLand).toBe(false);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasRevisionsToLand).toBe(false);
  });

  it('re-asks when the branch tip moves (e.g. the landing’s merge commit)', async () => {
    // Given: work to land at first, none after the tip moves
    const bridge = window.electronAPI.lore.revisionsToLand as jest.Mock;
    bridge.mockResolvedValueOnce({ success: true, data: true });
    bridge.mockResolvedValue({ success: true, data: false });

    // When: the hook mounts, then the branch tip changes
    const { result, rerender } = renderHook(
      ({ tip }: { tip: string }) => useRevisionsToLand(repoA, 'feat/topic', 'main', true, tip),
      { initialProps: { tip: 'tip-1' } }
    );
    await waitFor(() => expect(result.current.hasRevisionsToLand).toBe(true));
    rerender({ tip: 'tip-2' });

    // Then: the predicate is re-fetched and the answer flips
    await waitFor(() => expect(result.current.hasRevisionsToLand).toBe(false));
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it('never fetches when the target IS the branch, or when disconnected', () => {
    // When: mounting on the target branch itself, and mounting disconnected
    renderHook(() => useRevisionsToLand(repoA, 'main', 'main', true, 'tip-1'));
    renderHook(() => useRevisionsToLand(repoA, 'feat/topic', 'main', false, 'tip-1'));

    // Then: no bridge call happens for either
    expect(window.electronAPI.lore.revisionsToLand).not.toHaveBeenCalled();
  });
});
