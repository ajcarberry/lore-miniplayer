jest.mock('../../../src/renderer/utils/logging', () => ({
  logError: jest.fn(),
}));

import { act, renderHook, waitFor } from '@testing-library/react';
import { useBranchDivergence } from '../../../src/renderer/hooks/useBranchDivergence';
import { logError } from '../../../src/renderer/utils/logging';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeRepository } from '../../mocks/repository-fixture';
import { deferred } from '../../mocks/test-utils';
import type { BranchDivergence, Result } from '../../../src/shared/types';

const repoA = makeRepository({
  name: 'Repo A',
  url: 'lore.example.com/RepoA',
  localPath: '/repos/a',
});
const repoB = makeRepository({
  id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
  name: 'Repo B',
  url: 'lore.example.com/RepoB',
  localPath: '/repos/b',
});

describe('useBranchDivergence', () => {
  beforeEach(() => {
    installMockElectronAPI();
  });

  it('loads divergence for the selected repo and branch on mount', async () => {
    // Given: branchInfo resolves an inSync result
    (window.electronAPI.lore.branchInfo as jest.Mock).mockResolvedValue({
      success: true,
      data: { state: 'inSync', latest: 'abc', latestRemote: 'abc' },
    } satisfies Result<BranchDivergence>);

    // When: the hook mounts with a selected repo/branch
    const { result } = renderHook(() => useBranchDivergence(repoA, 'main', true));

    // Then: it resolves the divergence and stops loading
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.divergence).toEqual({
      state: 'inSync',
      latest: 'abc',
      latestRemote: 'abc',
    });
    expect(window.electronAPI.lore.branchInfo).toHaveBeenCalledWith('/repos/a', 'main');
  });

  it('does not fetch when disconnected', () => {
    // When: the hook mounts while disconnected
    const { result } = renderHook(() => useBranchDivergence(repoA, 'main', false));

    // Then: no fetch happens and state stays empty
    expect(window.electronAPI.lore.branchInfo).not.toHaveBeenCalled();
    expect(result.current.divergence).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when no repository is selected', () => {
    // When: the hook mounts with no selected repo
    const { result } = renderHook(() => useBranchDivergence(null, 'main', true));

    // Then: no fetch happens
    expect(window.electronAPI.lore.branchInfo).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when the branch name is empty', () => {
    // When: the hook mounts before a branch has loaded
    const { result } = renderHook(() => useBranchDivergence(repoA, '', true));

    // Then: no fetch happens
    expect(window.electronAPI.lore.branchInfo).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('refetches when the branch changes', async () => {
    // Given: branchInfo resolves per call
    (window.electronAPI.lore.branchInfo as jest.Mock).mockResolvedValue({
      success: true,
      data: { state: 'inSync', latest: 'abc', latestRemote: 'abc' },
    });
    const { rerender } = renderHook(({ branch }) => useBranchDivergence(repoA, branch, true), {
      initialProps: { branch: 'main' },
    });
    await waitFor(() =>
      expect(window.electronAPI.lore.branchInfo).toHaveBeenCalledWith('/repos/a', 'main')
    );

    // When: the current branch changes
    rerender({ branch: 'feature' });

    // Then: a fresh fetch is made for the new branch
    await waitFor(() =>
      expect(window.electronAPI.lore.branchInfo).toHaveBeenCalledWith('/repos/a', 'feature')
    );
  });

  it('sets divergence to null and logs when the IPC call fails', async () => {
    // Given: branchInfo rejects
    (window.electronAPI.lore.branchInfo as jest.Mock).mockRejectedValue(new Error('IPC down'));

    // When: the hook mounts
    const { result } = renderHook(() => useBranchDivergence(repoA, 'main', true));

    // Then: it settles with a null divergence rather than throwing, and the
    // failure is logged with the hook's operation context
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.divergence).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      'Failed to load branch divergence',
      expect.objectContaining({
        localPath: '/repos/a',
        branch: 'main',
        operation: 'useBranchDivergence',
      })
    );
  });

  it('refresh() re-fetches on demand', async () => {
    // Given: the initial load has settled
    (window.electronAPI.lore.branchInfo as jest.Mock).mockResolvedValue({
      success: true,
      data: { state: 'inSync', latest: 'abc', latestRemote: 'abc' },
    });
    const { result } = renderHook(() => useBranchDivergence(repoA, 'main', true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    (window.electronAPI.lore.branchInfo as jest.Mock).mockClear();

    // When: refresh is called explicitly
    await act(async () => {
      await result.current.refresh();
    });

    // Then: a new fetch is issued
    expect(window.electronAPI.lore.branchInfo).toHaveBeenCalledWith('/repos/a', 'main');
  });

  it('ignores a stale response from a superseded repository', async () => {
    // Given: the first repo's fetch is left pending while a second repo resolves
    const first = deferred<Result<BranchDivergence>>();
    const branchInfoMock = window.electronAPI.lore.branchInfo as jest.Mock;
    branchInfoMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      success: true,
      data: { state: 'behindOrDiverged', latest: 'b', latestRemote: 'c' },
    } satisfies Result<BranchDivergence>);

    const { result, rerender } = renderHook(({ repo }) => useBranchDivergence(repo, 'main', true), {
      initialProps: { repo: repoA },
    });

    // When: the selected repository changes before the first request resolves
    rerender({ repo: repoB });
    await waitFor(() => expect(result.current.divergence?.state).toBe('behindOrDiverged'));

    // And: the stale first request finally resolves
    await act(async () => {
      first.resolve({
        success: true,
        data: { state: 'inSync', latest: 'a', latestRemote: 'a' },
      });
      await Promise.resolve();
    });

    // Then: the stale response does not overwrite the newer repo's state
    expect(result.current.divergence?.state).toBe('behindOrDiverged');
  });
});
