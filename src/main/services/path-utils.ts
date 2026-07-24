import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// True when two paths resolve to the same absolute location (the app's
// canonical path-equality check for registry entries and workspace paths).
export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

// Whether the target exists on disk; any access failure reads as absent.
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
