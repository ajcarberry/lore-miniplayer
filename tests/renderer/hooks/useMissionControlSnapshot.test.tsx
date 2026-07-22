import { act, renderHook, waitFor } from '@testing-library/react';
import { useMissionControlSnapshot } from '../../../src/renderer/hooks/useMissionControlSnapshot';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeCard, REPO_ID } from '../mission-control/fixtures';
import type { WorkspaceModelSnapshot } from '../../../src/shared/types';

const OTHER_REPO_ID = '33333333-3333-4333-8333-333333333333';

function snapshot(repositoryId: string): WorkspaceModelSnapshot {
  return { repositoryId, cards: [makeCard('awaitingReview')] };
}

type SnapshotListener = (payload: unknown) => void;

function installMissionControl(watchResult: {
  success: boolean;
  data?: WorkspaceModelSnapshot;
  error?: string;
}): { watch: jest.Mock; onSnapshot: jest.Mock } {
  const api = installMockElectronAPI();
  const watch = jest.fn().mockResolvedValue(watchResult);
  const onSnapshot = jest.fn().mockReturnValue(jest.fn());
  Object.assign(api, { missionControl: { open: jest.fn(), close: jest.fn(), watch, onSnapshot } });
  return { watch, onSnapshot };
}

function firePush(onSnapshot: jest.Mock, payload: unknown): void {
  const listener = onSnapshot.mock.calls[0]?.[0] as SnapshotListener | undefined;
  if (!listener) {
    throw new Error('no snapshot listener registered');
  }
  act(() => listener(payload));
}

describe('useMissionControlSnapshot', () => {
  it('watches the repository and seeds the cards from the returned snapshot', async () => {
    const { watch } = installMissionControl({ success: true, data: snapshot(REPO_ID) });

    const { result } = renderHook(() => useMissionControlSnapshot(REPO_ID));

    expect(watch).toHaveBeenCalledWith(REPO_ID);
    await waitFor(() => expect(result.current).toHaveLength(1));
  });

  it('updates from a matching push and ignores other repos and malformed payloads', async () => {
    const { onSnapshot } = installMissionControl({
      success: true,
      data: { repositoryId: REPO_ID, cards: [] },
    });

    const { result } = renderHook(() => useMissionControlSnapshot(REPO_ID));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalled());

    firePush(onSnapshot, snapshot(OTHER_REPO_ID));
    firePush(onSnapshot, { bogus: true });
    expect(result.current).toHaveLength(0);

    firePush(onSnapshot, snapshot(REPO_ID));
    expect(result.current).toHaveLength(1);
  });

  it('leaves cards empty when the watch invoke fails', async () => {
    const { watch, onSnapshot } = installMissionControl({ success: false, error: 'boom' });

    const { result } = renderHook(() => useMissionControlSnapshot(REPO_ID));
    await waitFor(() => expect(watch).toHaveBeenCalled());
    await waitFor(() => expect(onSnapshot).toHaveBeenCalled());

    expect(result.current).toEqual([]);
  });

  it('clears cards and does not watch when no repository is selected', () => {
    const { watch } = installMissionControl({ success: true, data: snapshot(REPO_ID) });
    const { result } = renderHook(() => useMissionControlSnapshot(null));
    expect(watch).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it('removes the snapshot listener on unmount', async () => {
    const remove = jest.fn();
    const api = installMockElectronAPI();
    const onSnapshot = jest.fn().mockReturnValue(remove);
    Object.assign(api, {
      missionControl: {
        open: jest.fn(),
        close: jest.fn(),
        watch: jest.fn().mockResolvedValue({ success: true, data: snapshot(REPO_ID) }),
        onSnapshot,
      },
    });

    const { unmount } = renderHook(() => useMissionControlSnapshot(REPO_ID));
    await waitFor(() => expect(onSnapshot).toHaveBeenCalled());
    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
