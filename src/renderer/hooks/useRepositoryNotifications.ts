import { useEffect, useRef } from 'react';
import type { Repository, RepositoryNotificationKind } from '../../shared/types';
import { RepositoryNotificationSchema } from '../../shared/schemas';
import { logError } from '../utils/logging';

// Subscribes to the server's push notifications for the selected repository
// and invokes `onNotification` for each recognized event. Replaces polling:
// the server tells us when a branch is pushed, created, or deleted, and the
// consumer refreshes whatever derived state it owns. The subscription follows
// the selection — switching repositories unsubscribes the old path and
// subscribes the new one.
export function useRepositoryNotifications(
  selectedRepo: Repository | null,
  isConnected: boolean,
  onNotification: (kind: RepositoryNotificationKind) => void
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
      callbackRef.current(parsed.data.kind);
    });

    return (): void => {
      removeListener();
      void window.electronAPI.lore.notifications.unsubscribe(localPath);
    };
  }, [selectedRepo, isConnected]);
}
