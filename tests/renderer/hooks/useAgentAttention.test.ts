import { act, renderHook, waitFor } from '@testing-library/react';
import { useAgentAttention } from '../../../src/renderer/hooks/useAgentAttention';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeCard, REPO_ID } from '../mission-control/fixtures';
import type { BranchGraph, WorkspaceModelSnapshot } from '../../../src/shared/types';

const EMPTY_GRAPH: BranchGraph = {
  current: '',
  branch: { name: '', revisions: [] },
  mergesFromParent: [],
  mergesToParent: [],
};

function graphWithTip(revisionNumber: number): BranchGraph {
  return {
    ...EMPTY_GRAPH,
    branch: { name: 'main', revisions: [{ revision: `r${revisionNumber}`, revisionNumber }] },
  };
}

function install(watchData: WorkspaceModelSnapshot): { open: jest.Mock } {
  const api = installMockElectronAPI();
  const open = jest.fn();
  Object.assign(api, {
    missionControl: {
      open,
      close: jest.fn(),
      watch: jest.fn().mockResolvedValue({ success: true, data: watchData }),
      onSnapshot: jest.fn().mockReturnValue(jest.fn()),
    },
  });
  return { open };
}

describe('useAgentAttention', () => {
  it('reports zero counts and no toast with an empty snapshot', async () => {
    // Given: no workspaces at all
    install({ repositoryId: REPO_ID, cards: [] });

    // When: the hook mounts
    const { result } = renderHook(() => useAgentAttention(REPO_ID, 'main', EMPTY_GRAPH));

    // Then: both counts are zero and there is nothing to toast
    await waitFor(() => expect(result.current.needsYouCount).toBe(0));
    expect(result.current.activeCount).toBe(0);
    expect(result.current.toast).toBeNull();
  });

  it('surfaces the aggregate needsYou count from the Mission Control snapshot', async () => {
    // Given: one card needing attention
    install({
      repositoryId: REPO_ID,
      cards: [
        makeCard('awaitingReview', {
          attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
        }),
      ],
    });

    // When: the hook mounts
    const { result } = renderHook(() => useAgentAttention(REPO_ID, 'main', EMPTY_GRAPH));

    // Then: the needsYou count reaches 1
    await waitFor(() => expect(result.current.needsYouCount).toBe(1));
  });

  it('opens Mission Control for the given repository id', async () => {
    // Given: a mounted hook, settled past its initial snapshot fetch
    const { open } = install({ repositoryId: REPO_ID, cards: [] });
    const { result } = renderHook(() => useAgentAttention(REPO_ID, 'main', EMPTY_GRAPH));
    await waitFor(() => expect(result.current.needsYouCount).toBe(0));

    // When: calling onOpenMissionControl
    result.current.onOpenMissionControl();

    // Then: the IPC call carries the repository id
    expect(open).toHaveBeenCalledWith(REPO_ID);
  });

  it('formats a pushed toast against the supplied branch and revision number', async () => {
    // Given: a mounted hook, settled past its initial snapshot fetch
    install({ repositoryId: REPO_ID, cards: [] });
    const { result } = renderHook(() =>
      useAgentAttention(REPO_ID, 'feature/act-two', graphWithTip(128))
    );
    await waitFor(() => expect(result.current.needsYouCount).toBe(0));

    // When: pushing a branchPushed notification
    act(() =>
      result.current.pushToast({
        repositoryPath: '/tmp/repo',
        kind: 'branchPushed',
        userId: 'mara-voss',
      })
    );

    // Then: the toast is formatted with the branch and revision
    expect(result.current.toast?.message).toBe('mara-voss pushed r128 to feature/act-two');
  });

  it('dismisses the current toast, clearing it', async () => {
    // Given: a toast pushed, hook settled past its initial snapshot fetch
    install({ repositoryId: REPO_ID, cards: [] });
    const { result } = renderHook(() => useAgentAttention(REPO_ID, 'main', EMPTY_GRAPH));
    await waitFor(() => expect(result.current.needsYouCount).toBe(0));
    act(() =>
      result.current.pushToast({ repositoryPath: '/tmp/repo', kind: 'branchPushed', userId: 'a' })
    );
    expect(result.current.toast).not.toBeNull();

    // When: dismissing it
    act(() => result.current.onDismissToast());

    // Then: no toast remains
    expect(result.current.toast).toBeNull();
  });
});
