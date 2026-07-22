import { act, renderHook } from '@testing-library/react';
import { useAttributionToasts } from '../../../src/renderer/hooks/useAttributionToasts';
import type { RepositoryNotification } from '../../../src/shared/types';

function pushNotification(overrides: Partial<RepositoryNotification> = {}): RepositoryNotification {
  return {
    repositoryPath: '/tmp/my-repo',
    kind: 'branchPushed',
    userId: 'mara-voss',
    ...overrides,
  };
}

describe('useAttributionToasts', () => {
  it('starts with no current toast', () => {
    // When: the hook mounts with nothing pushed
    const { result } = renderHook(() => useAttributionToasts());

    // Then: the queue is empty
    expect(result.current.current).toBeNull();
  });

  it('surfaces a pushed notification as the current toast', () => {
    // Given: a mounted hook
    const { result } = renderHook(() => useAttributionToasts());

    // When: pushing a notification
    act(() => result.current.push(pushNotification()));

    // Then: it becomes the current toast
    expect(result.current.current?.notification).toEqual(pushNotification());
  });

  it('queues a second push behind the first — one at a time', () => {
    // Given: a mounted hook with one toast already queued
    const { result } = renderHook(() => useAttributionToasts());
    act(() => result.current.push(pushNotification({ userId: 'first' })));
    const firstId = result.current.current?.id;

    // When: pushing a second notification before the first dismisses
    act(() => result.current.push(pushNotification({ userId: 'second' })));

    // Then: the first toast is still current, unchanged
    expect(result.current.current?.id).toBe(firstId);
    expect(result.current.current?.notification.userId).toBe('first');
  });

  it('reveals the next toast in the queue after dismiss', () => {
    // Given: two toasts queued
    const { result } = renderHook(() => useAttributionToasts());
    act(() => result.current.push(pushNotification({ userId: 'first' })));
    act(() => result.current.push(pushNotification({ userId: 'second' })));

    // When: dismissing the current one
    act(() => result.current.dismiss());

    // Then: the second toast is now current
    expect(result.current.current?.notification.userId).toBe('second');
  });

  it('returns to empty after the last toast is dismissed', () => {
    // Given: a single queued toast
    const { result } = renderHook(() => useAttributionToasts());
    act(() => result.current.push(pushNotification()));

    // When: dismissing it
    act(() => result.current.dismiss());

    // Then: the queue is empty again
    expect(result.current.current).toBeNull();
  });

  it('dismissing an empty queue is a no-op', () => {
    // Given: a mounted hook with nothing queued
    const { result } = renderHook(() => useAttributionToasts());

    // When: dismissing anyway
    act(() => result.current.dismiss());

    // Then: still empty, no error
    expect(result.current.current).toBeNull();
  });

  it('assigns distinct ids to successive pushes', () => {
    // Given: a mounted hook
    const { result } = renderHook(() => useAttributionToasts());

    // When: pushing two notifications and reading both ids in turn
    act(() => result.current.push(pushNotification({ userId: 'first' })));
    const firstId = result.current.current?.id;
    act(() => result.current.dismiss());
    act(() => result.current.push(pushNotification({ userId: 'second' })));
    const secondId = result.current.current?.id;

    // Then: the ids differ
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(firstId).not.toBe(secondId);
  });
});
