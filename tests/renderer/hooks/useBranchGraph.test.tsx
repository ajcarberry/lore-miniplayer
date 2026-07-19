jest.mock('../../../src/renderer/utils/logging', () => ({
  logError: jest.fn(),
}));

import { act, renderHook, waitFor } from '@testing-library/react';
import { useBranchGraph } from '../../../src/renderer/hooks/useBranchGraph';
import { logError } from '../../../src/renderer/utils/logging';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeRepository } from '../../mocks/repository-fixture';
import { deferred } from '../../mocks/test-utils';
import type { BranchGraph, Result } from '../../../src/shared/types';

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

const sampleGraph: BranchGraph = {
  current: 'newer-hash',
  branch: {
    name: 'main',
    revisions: [
      { revision: 'newer-hash', revisionNumber: 42 },
      { revision: 'older-hash', revisionNumber: 41 },
    ],
  },
  mergesFromParent: [],
  mergesToParent: [],
};

const emptyGraph: BranchGraph = {
  current: '',
  branch: { name: '', revisions: [] },
  mergesFromParent: [],
  mergesToParent: [],
};

describe('useBranchGraph', () => {
  beforeEach(() => {
    installMockElectronAPI();
  });

  it('loads the branch graph for the selected repo and branch on mount', async () => {
    // Given: branchGraph resolves a graph
    (window.electronAPI.lore.branchGraph as jest.Mock).mockResolvedValue({
      success: true,
      data: sampleGraph,
    } satisfies Result<BranchGraph>);

    // When: the hook mounts with a selected repo/branch
    const { result } = renderHook(() => useBranchGraph(repoA, 'main', true));

    // Then: it resolves the graph and stops loading
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.graph).toEqual(sampleGraph);
    expect(window.electronAPI.lore.branchGraph).toHaveBeenCalledWith('/repos/a', 'main');
  });

  it('does not fetch when disconnected', () => {
    // When: the hook mounts while disconnected
    const { result } = renderHook(() => useBranchGraph(repoA, 'main', false));

    // Then: no fetch happens and state stays empty
    expect(window.electronAPI.lore.branchGraph).not.toHaveBeenCalled();
    expect(result.current.graph).toEqual(emptyGraph);
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when no repository is selected', () => {
    // When: the hook mounts with no selected repo
    const { result } = renderHook(() => useBranchGraph(null, 'main', true));

    // Then: no fetch happens
    expect(window.electronAPI.lore.branchGraph).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not fetch when the branch name is empty', () => {
    // When: the hook mounts before a branch has loaded
    const { result } = renderHook(() => useBranchGraph(repoA, '', true));

    // Then: no fetch happens
    expect(window.electronAPI.lore.branchGraph).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('refetches when the branch changes', async () => {
    // Given: branchGraph resolves per call
    (window.electronAPI.lore.branchGraph as jest.Mock).mockResolvedValue({
      success: true,
      data: sampleGraph,
    });
    const { rerender } = renderHook(({ branch }) => useBranchGraph(repoA, branch, true), {
      initialProps: { branch: 'main' },
    });
    await waitFor(() =>
      expect(window.electronAPI.lore.branchGraph).toHaveBeenCalledWith('/repos/a', 'main')
    );

    // When: the current branch changes
    rerender({ branch: 'feature' });

    // Then: a fresh fetch is made for the new branch
    await waitFor(() =>
      expect(window.electronAPI.lore.branchGraph).toHaveBeenCalledWith('/repos/a', 'feature')
    );
  });

  it('falls back to the empty graph and logs when the IPC call fails', async () => {
    // Given: branchGraph rejects
    (window.electronAPI.lore.branchGraph as jest.Mock).mockRejectedValue(new Error('IPC down'));

    // When: the hook mounts
    const { result } = renderHook(() => useBranchGraph(repoA, 'main', true));

    // Then: it settles with the empty graph rather than throwing, and the
    // failure is logged with the hook's operation context
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.graph).toEqual(emptyGraph);
    expect(logError).toHaveBeenCalledWith(
      'Failed to load branch graph',
      expect.objectContaining({
        localPath: '/repos/a',
        branch: 'main',
        operation: 'useBranchGraph',
      })
    );
  });

  it('falls back to the empty graph when the IPC call reports a failure result', async () => {
    // Given: branchGraph resolves a failure result
    (window.electronAPI.lore.branchGraph as jest.Mock).mockResolvedValue({
      success: false,
      error: 'no such branch',
    } satisfies Result<BranchGraph>);

    // When: the hook mounts
    const { result } = renderHook(() => useBranchGraph(repoA, 'main', true));

    // Then: it settles with the empty graph
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.graph).toEqual(emptyGraph);
  });

  it('refresh() re-fetches on demand', async () => {
    // Given: the initial load has settled
    (window.electronAPI.lore.branchGraph as jest.Mock).mockResolvedValue({
      success: true,
      data: sampleGraph,
    });
    const { result } = renderHook(() => useBranchGraph(repoA, 'main', true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    (window.electronAPI.lore.branchGraph as jest.Mock).mockClear();

    // When: refresh is called explicitly
    await act(async () => {
      await result.current.refresh();
    });

    // Then: a new fetch is issued
    expect(window.electronAPI.lore.branchGraph).toHaveBeenCalledWith('/repos/a', 'main');
  });

  it('ignores a stale response from a superseded repository', async () => {
    // Given: the first repo's fetch is left pending while a second repo resolves
    const first = deferred<Result<BranchGraph>>();
    const branchGraphMock = window.electronAPI.lore.branchGraph as jest.Mock;
    branchGraphMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
      success: true,
      data: sampleGraph,
    } satisfies Result<BranchGraph>);

    const { result, rerender } = renderHook(({ repo }) => useBranchGraph(repo, 'main', true), {
      initialProps: { repo: repoA },
    });

    // When: the selected repository changes before the first request resolves
    rerender({ repo: repoB });
    await waitFor(() => expect(result.current.graph).toEqual(sampleGraph));

    // And: the stale first request finally resolves
    await act(async () => {
      first.resolve({
        success: true,
        data: { ...emptyGraph, current: 'stale-hash' },
      });
      await Promise.resolve();
    });

    // Then: the stale response does not overwrite the newer repo's state
    expect(result.current.graph).toEqual(sampleGraph);
  });
});
