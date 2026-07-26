import { execFileSync } from 'node:child_process';

// Playwright's electron.launch runs the dev Electron binary, whose bundle id is
// com.github.Electron (not the developer's real apps).
const ELECTRON_BUNDLE_ID = 'com.github.Electron';

// The suite force-kills wedged Electron instances (see reaper.ts / closeAppBounded)
// when a launch/quit stalls. macOS then flags the bundle as having crashed and, on
// the next launch, shows "Electron unexpectedly quit while reopening windows".
// Disabling AppKit window-state restoration for that one bundle suppresses the
// dialog.
//
// The key is written idempotently on every setup and deliberately never deleted:
// it's global to the machine (keyed by bundle id, not pid or working directory),
// so a teardown-time delete would need cross-run coordination to avoid clearing
// it out from under a concurrent sibling run (another worktree, a manual
// invocation). Leaving it set costs nothing — the bundle id only ever belongs to
// throwaway dev/test Electron instances, which nobody wants state restoration
// for. Undo by hand if ever needed:
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
