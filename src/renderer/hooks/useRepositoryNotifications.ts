import { useEffect, useRef } from 'react';
import type { Repository, RepositoryNotification } from '../../shared/types';
import { RepositoryNotificationSchema } from '../../shared/schemas';
import { logError } from '../utils/logging';

// Subscribes to the server's push notifications for the selected repository
// and invokes `onNotification` with the full validated payload for each
// recognized event — not just its kind, so consumers can read branchPushed's
// userId and the lock kinds' userId/branch/paths (design 1c's attribution
// toast + conflict visibility). Replaces polling: the server tells us when a
// branch is pushed, created, deleted, or a resource locked/unlocked, and the
// consumer refreshes whatever derived state it owns. The subscription
// follows the selection — switching repositories unsubscribes the old path
// and subscribes the new one.
export function useRepositoryNotifications(
  selectedRepo: Repository | null,
  isConnected: boolean,
  onNotification: (notification: RepositoryNotification) => void
): void {
  // Ref so a new callback identity never tears down the subscription.
  const callbackRef = useRef(onNotification);
  useEffect(() => {
    callbackRef.current = onNotification;
  }, [onNotification]);

  useEffect(() => {
    if (!selectedRepo || !isConnected) {
      return undefined;
    }
    const { localPath } = selectedRepo;

    void window.electronAPI.lore.notifications.subscribe(localPath).then(result => {
      if (!result.success) {
        logError('Failed to subscribe to repository notifications', {
          error: result.error,
          localPath,
          operation: 'useRepositoryNotifications',
        });
      }
    });

    const removeListener = window.electronAPI.lore.notifications.onNotification(payload => {
      const parsed = RepositoryNotificationSchema.safeParse(payload);
      if (!parsed.success || parsed.data.repositoryPath !== localPath) {
        return;
      }
      callbackRef.current(parsed.data);
    });

    return (): void => {
      removeListener();
      void window.electronAPI.lore.notifications.unsubscribe(localPath);
    };
  }, [selectedRepo, isConnected]);
}
