import { execFileSync } from 'node:child_process';
import { APP_MAIN } from '../launch';

// SAFELY-scoped orphan reaper for the live Electron suite.
//
// The scoping key is the absolute path of THIS repo's built main entry
// (`out/main/index.js`, from launch.ts's APP_MAIN). Every suite launch is
// `electron.launch({ args: [APP_MAIN], … })`, so that exact path is in the
// Electron main process's argv and nothing else on the machine runs it — the
// developer's own Electron/Chrome apps launch from their own bundles. This is
// deliberately NOT a blanket `pkill electron`.

// The immediate children of `pid` (empty when it has none — pgrep exits 1).
function childrenOf(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

// A SIGKILL that ignores an already-dead pid.
function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ESRCH — the process already exited.
  }
}

// Kill one Electron main and every process it spawned (renderer/GPU/utility
// helpers), children before parents so nothing is re-parented mid-walk.
export function killProcessTree(pid: number): void {
  const tree: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenOf(current)) {
      tree.push(child);
      queue.push(child);
    }
  }
  for (const child of tree.reverse()) {
    forceKill(child);
  }
  forceKill(pid);
}

// PIDs of every live Electron main launched from this suite's APP_MAIN.
export function suiteMainPids(): number[] {
  try {
    return execFileSync('pgrep', ['-f', APP_MAIN], { encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

// Reap every straggler Electron tree belonging to this suite. Returns how many
// main processes were found (0 on a clean table). Used by global setup (clear
// leftovers from a previously aborted run) and global teardown (final net).
export function reapSuiteElectron(): number {
  const mains = suiteMainPids();
  for (const pid of mains) {
    killProcessTree(pid);
  }
  return mains.length;
}
