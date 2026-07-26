// Main-process state about a repository checkout's in-flight merge that
// modules OUTSIDE the merge service need, without importing the service (and
// with it the SDK): the review window's lifecycle needs to abort an orphaned
// merge. Keyed by checkout path — one merge per checkout (MergeService's own
// rule).

// Abort callbacks registered by MergeService.start, cleared whenever the merge
// ends (abort/complete/failed landing that discards the merge).
const activeMerges = new Map<string, () => Promise<void>>();

export function registerActiveMerge(checkoutPath: string, abort: () => Promise<void>): void {
  activeMerges.set(checkoutPath, abort);
}

export function clearActiveMerge(checkoutPath: string): void {
  activeMerges.delete(checkoutPath);
}

// Abort the checkout's merge if one is in flight, reporting whether there was
// anything to abort. The caller (the review window's close/re-target path)
// owns error logging: an abort failure must never break window teardown.
export async function abortActiveMerge(checkoutPath: string): Promise<boolean> {
  const abort = activeMerges.get(checkoutPath);
  if (!abort) {
    return false;
  }
  await abort();
  return true;
}
