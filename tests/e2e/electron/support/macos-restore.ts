import { execFileSync } from 'node:child_process';

// Playwright launches the dev Electron binary; this is its bundle id, not the
// packaged app's.
const ELECTRON_BUNDLE_ID = 'com.github.Electron';

// After the reaper force-kills a wedged instance, macOS shows "Electron
// unexpectedly quit while reopening windows" on the next launch unless AppKit
// state restoration is off for the bundle. The key is machine-global (keyed by
// bundle id), so it's written idempotently every setup and never deleted —
// concurrent runs then have nothing to coordinate, and the bundle id only ever
// belongs to throwaway dev/test instances. Undo by hand:
//   defaults delete com.github.Electron ApplePersistenceIgnoreState
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
