import { execFileSync } from 'node:child_process';
import { APP_MAIN } from '../launch';

// Orphan reaper for the live Electron suite, scoped to THIS repo's built main
// entry (APP_MAIN, from launch.ts). Every suite launch passes that absolute
// path as Electron's argv, so it identifies our processes without a blanket
// `pkill electron`. Matches are also confirmed to be Electron, so an unrelated
// process that merely names the path (an editor, a grep) is spared.

// The full command line of `pid`, or '' if it has exited.
function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

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

// PIDs of every live Electron main launched from this suite's APP_MAIN. `pgrep
// -f` matches any argv containing the path, so results are filtered to actual
// Electron processes.
export function suiteMainPids(): number[] {
  let candidates: number[];
  try {
    candidates = execFileSync('pgrep', ['-f', APP_MAIN], { encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
  return candidates.filter(pid => /electron/i.test(commandOf(pid)));
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
