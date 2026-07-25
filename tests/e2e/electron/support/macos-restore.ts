import { execFileSync } from 'node:child_process';

// Playwright's electron.launch runs the dev Electron binary, whose bundle id is
// com.github.Electron (not the developer's real apps).
const ELECTRON_BUNDLE_ID = 'com.github.Electron';

// The suite force-kills wedged Electron instances (see reaper.ts / closeAppBounded)
// when a launch/quit stalls. macOS then flags the bundle as having crashed and, on
// the next launch, shows "Electron unexpectedly quit while reopening windows".
// Disabling AppKit window-state restoration for that one bundle suppresses the
// dialog. macOS-only, scoped to the dev Electron bundle, and cleared in global
// teardown so it leaves no lasting machine change.
export function suppressMacWindowRestore(): void {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    execFileSync('defaults', [
      'write',
      ELECTRON_BUNDLE_ID,
      'ApplePersistenceIgnoreState',
      '-bool',
      'YES',
    ]);
  } catch {
    // best-effort: not fatal if `defaults` is unavailable
  }
}

export function restoreMacWindowRestore(): void {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    execFileSync('defaults', ['delete', ELECTRON_BUNDLE_ID, 'ApplePersistenceIgnoreState']);
  } catch {
    // best-effort: the key may already be absent
  }
}
