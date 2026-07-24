import type { Result } from '../../shared/types';
import { logError } from './logging';

export interface SubscribeThenPullArgs<TPush, TPull> {
  // Registers the push listener; returns its remover. Registered BEFORE the
  // pull is invoked so a payload emitted during the pull is never missed.
  readonly subscribe: (listener: (payload: unknown) => void) => () => void;
  // Zod-validates (and optionally filters) a push payload; null drops it.
  readonly parsePush: (payload: unknown) => TPush | null;
  readonly onPush: (data: TPush) => void;
  readonly pull: () => Promise<Result<TPull>>;
  readonly onPull: (data: TPull) => void;
  // logError context for a failed pull (message + structured fields).
  readonly pullErrorMessage: string;
  readonly pullErrorContext: Record<string, unknown>;
}

// The shared subscribe-then-pull skeleton behind the push-channel hooks
// (Mission Control snapshots, review context): register the push listener
// first, then invoke the pull IPC, guarding the pull's resolution with a
// cancelled flag. Returns the cleanup for the caller's effect.
export function subscribeThenPull<TPush, TPull>(
  args: SubscribeThenPullArgs<TPush, TPull>
): () => void {
  let cancelled = false;

  const removeListener = args.subscribe(payload => {
    const parsed = args.parsePush(payload);
    if (parsed !== null) {
      args.onPush(parsed);
    }
  });

  void args.pull().then(result => {
    if (cancelled) {
      return;
    }
    if (result.success) {
      args.onPull(result.data);
    } else {
      logError(args.pullErrorMessage, { error: result.error, ...args.pullErrorContext });
    }
  });

  return (): void => {
    cancelled = true;
    removeListener();
  };
}
