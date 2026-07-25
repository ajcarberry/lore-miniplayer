import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Playwright's electron.launch runs the dev Electron binary, whose bundle id is
// com.github.Electron (not the developer's real apps).
const ELECTRON_BUNDLE_ID = 'com.github.Electron';

// The suite force-kills wedged Electron instances (see reaper.ts / closeAppBounded)
// when a launch/quit stalls. macOS then flags the bundle as having crashed and, on
// the next launch, shows "Electron unexpectedly quit while reopening windows".
// Disabling AppKit window-state restoration for that one bundle suppresses the
// dialog. macOS-only, scoped to the dev Electron bundle, and cleared in global
// teardown so it leaves no lasting machine change.
//
// The `defaults` key is global to the machine (keyed by bundle id, not by pid or
// working directory), so two concurrent runs — two worktrees, or two manual
// invocations here — share it. A naive "set on setup, delete on teardown" pair
// would let one run's teardown delete the key out from under a sibling run still
// mid-suite. Instead, each run drops a sentinel file (named for its own pid) in a
// shared lock directory before writing the key, and only deletes the key once its
// own sentinel is gone and no one else's is left — i.e. it's a refcount, using the
// filesystem as the counter.
const LOCK_DIR = path.join(os.tmpdir(), 'lore-miniplayer-e2e-restore-lock');

function sentinelPath(): string {
  return path.join(LOCK_DIR, String(process.pid));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Sentinels left behind by a run that never reached teardown (killed, crashed)
// would otherwise wedge the key set forever. Prune any whose owning pid is no
// longer alive before deciding whether we're the last finisher.
function pruneDeadSentinels(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(LOCK_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (Number.isInteger(pid) && !isRunning(pid)) {
      fs.rmSync(path.join(LOCK_DIR, entry), { force: true });
    }
  }
}

export function suppressMacWindowRestore(): void {
  if (process.platform !== 'darwin') {
    return;
  }
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(sentinelPath(), '');
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
    fs.rmSync(sentinelPath(), { force: true });
    pruneDeadSentinels();
    const othersActive = fs.existsSync(LOCK_DIR) && fs.readdirSync(LOCK_DIR).length > 0;
    if (othersActive) {
      // A sibling run still wants the key set — leave it for the last finisher
      // to clear rather than deleting it out from under them.
      return;
    }
    execFileSync('defaults', ['delete', ELECTRON_BUNDLE_ID, 'ApplePersistenceIgnoreState']);
  } catch {
    // best-effort: the key may already be absent
  }
}
