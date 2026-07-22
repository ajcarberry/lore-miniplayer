import { useCallback, useRef, useState } from 'react';
import type { RepositoryNotification } from '../../shared/types';

export interface QueuedAttributionToast {
  readonly id: string;
  readonly notification: RepositoryNotification;
}

export interface AttributionToastsState {
  // The toast currently shown, or null when the queue is empty — one at a
  // time (design 1c). Raw notification, not a formatted string: the
  // message is derived at render time from live branch/graph state (see
  // formatAttributionMessage), so it can't go stale between the push
  // notification and the branch refresh it triggers.
  readonly current: QueuedAttributionToast | null;
  // Advances the queue: drops the current toast, revealing the next.
  readonly dismiss: () => void;
  readonly push: (notification: RepositoryNotification) => void;
}

// Queues card-top attribution toasts (push/lock/unlock) so they show one at
// a time rather than stacking. Auto-dismiss timing lives in the
// AttributionToast component itself; this hook only manages the queue.
export function useAttributionToasts(): AttributionToastsState {
  const [queue, setQueue] = useState<QueuedAttributionToast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((notification: RepositoryNotification): void => {
    nextId.current += 1;
    const id = `attribution-toast-${nextId.current}`;
    setQueue(current => [...current, { id, notification }]);
  }, []);

  const dismiss = useCallback((): void => {
    setQueue(current => current.slice(1));
  }, []);

  return { current: queue[0] ?? null, dismiss, push };
}
