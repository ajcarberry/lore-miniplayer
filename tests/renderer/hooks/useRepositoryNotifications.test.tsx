import { act, renderHook, waitFor } from '@testing-library/react';
import { useRepositoryNotifications } from '../../../src/renderer/hooks/useRepositoryNotifications';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeRepository } from '../../mocks/repository-fixture';

const repoA = makeRepository({
  name: 'Repo A',
  url: 'lore.example.com/RepoA',
  localPath: '/repos/a',
});

type NotificationListener = (payload: unknown) => void;

function registeredListener(): NotificationListener {
  const onNotification = window.electronAPI.lore.notifications.onNotification as jest.Mock;
  const listener = onNotification.mock.calls[0]?.[0] as NotificationListener | undefined;
  if (!listener) {
    throw new Error('no notification listener registered');
  }
  return listener;
}

describe('useRepositoryNotifications', () => {
  beforeEach(() => {
    installMockElectronAPI();
  });

  it('subscribes the selected repository and forwards its notifications', async () => {
    // Given: a mounted hook for a connected repo
    const onNotification = jest.fn();
    renderHook(() => useRepositoryNotifications(repoA, true, onNotification));
    await waitFor(() =>
      expect(window.electronAPI.lore.notifications.subscribe).toHaveBeenCalledWith('/repos/a')
    );

    // When: a push notification for this repository arrives
    act(() => {
      registeredListener()({ repositoryPath: '/repos/a', kind: 'branchPushed' });
    });

    // Then: the callback receives the full validated payload, not just the kind
    expect(onNotification).toHaveBeenCalledWith({
      repositoryPath: '/repos/a',
      kind: 'branchPushed',
    });
  });

  it('forwards branchPushed userId and lock-kind userId/branch/paths (design 1c attribution)', async () => {
    // Given: a mounted hook for a connected repo
    const onNotification = jest.fn();
    renderHook(() => useRepositoryNotifications(repoA, true, onNotification));
    await waitFor(() => expect(window.electronAPI.lore.notifications.subscribe).toHaveBeenCalled());

    // When: a push with a userId and a lock with userId/branch/paths arrive
    act(() => {
      registeredListener()({
        repositoryPath: '/repos/a',
        kind: 'branchPushed',
        userId: 'mara-voss',
      });
      registeredListener()({
        repositoryPath: '/repos/a',
        kind: 'resourceLocked',
        userId: 'rowan',
        branch: 'feature/act-two',
        paths: ['levels/act2/pacing.toml'],
      });
    });

    // Then: every field reaches the callback, not just the kind
    expect(onNotification).toHaveBeenNthCalledWith(1, {
      repositoryPath: '/repos/a',
      kind: 'branchPushed',
      userId: 'mara-voss',
    });
    expect(onNotification).toHaveBeenNthCalledWith(2, {
      repositoryPath: '/repos/a',
      kind: 'resourceLocked',
      userId: 'rowan',
      branch: 'feature/act-two',
      paths: ['levels/act2/pacing.toml'],
    });
  });

  it('ignores notifications for other repositories and malformed payloads', async () => {
    // Given: a mounted hook
    const onNotification = jest.fn();
    renderHook(() => useRepositoryNotifications(repoA, true, onNotification));
    await waitFor(() => expect(window.electronAPI.lore.notifications.subscribe).toHaveBeenCalled());

    // When: a different repo's notification and a malformed payload arrive
    act(() => {
      registeredListener()({ repositoryPath: '/repos/b', kind: 'branchPushed' });
      registeredListener()({ bogus: true });
    });

    // Then: neither reaches the callback
    expect(onNotification).not.toHaveBeenCalled();
  });

  it('does not subscribe while disconnected or without a selection', () => {
    // When: mounting disconnected and with no repo
    renderHook(() => useRepositoryNotifications(repoA, false, jest.fn()));
    renderHook(() => useRepositoryNotifications(null, true, jest.fn()));

    // Then: no subscription is opened
    expect(window.electronAPI.lore.notifications.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes and removes the listener on unmount', async () => {
    // Given: a cleanup fn returned by the bridge
    const off = jest.fn();
    (window.electronAPI.lore.notifications.onNotification as jest.Mock).mockReturnValue(off);
    const { unmount } = renderHook(() => useRepositoryNotifications(repoA, true, jest.fn()));
    await waitFor(() => expect(window.electronAPI.lore.notifications.subscribe).toHaveBeenCalled());

    // When: unmounting
    unmount();

    // Then: the listener is removed and the repository unsubscribed
    expect(off).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.lore.notifications.unsubscribe).toHaveBeenCalledWith('/repos/a');
  });

  it('resubscribes when the selected repository changes', async () => {
    // Given: a hook mounted on repo A
    const { rerender } = renderHook(
      ({ repo }) => useRepositoryNotifications(repo, true, jest.fn()),
      { initialProps: { repo: repoA } }
    );
    await waitFor(() =>
      expect(window.electronAPI.lore.notifications.subscribe).toHaveBeenCalledWith('/repos/a')
    );

    // When: switching to repo B
    const repoB = makeRepository({
      id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
      name: 'Repo B',
      localPath: '/repos/b',
    });
    rerender({ repo: repoB });

    // Then: A is unsubscribed and B subscribed
    await waitFor(() =>
      expect(window.electronAPI.lore.notifications.unsubscribe).toHaveBeenCalledWith('/repos/a')
    );
    await waitFor(() =>
      expect(window.electronAPI.lore.notifications.subscribe).toHaveBeenCalledWith('/repos/b')
    );
  });
});
