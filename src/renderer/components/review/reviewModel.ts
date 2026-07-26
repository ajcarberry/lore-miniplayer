import type {
  CompareTarget,
  FileDiffResult,
  LineStats,
  LoreFileStatus,
  LoreFileStatusGroup,
} from '../../../shared/types';

// A short human label for a compare picker target ("r128",
// "working tree", or a branch name).
export function compareTargetLabel(target: CompareTarget): string {
  switch (target.kind) {
    case 'revision':
      return target.revision;
    case 'workingTree':
      return 'working tree';
    case 'branchHead':
      return target.branch;
  }
}

// The Project View's per-file view model: the diff facts (action, stats,
// binary/truncation) merged with the working-tree status facts (staged flag,
// unresolved-conflict flag) the file list and commit bar need. One row per
// changed file in the compare result.
export interface ReviewFile {
  readonly path: string;
  readonly action: FileDiffResult['action'];
  readonly lineStats: LineStats | undefined;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly patch: string | undefined;
  readonly staged: boolean;
  // A conflict Lore still reports as unresolved: the file cannot be staged
  // until it is resolved, so its checkbox is disabled and marked with a warning.
  readonly conflictUnresolved: boolean;
}

// Indexes every file in the status groups by path so the diff list can look up
// its staged/conflict flags without caring which group Lore placed it in.
function indexStatus(status: LoreFileStatusGroup): Map<string, LoreFileStatus> {
  const byPath = new Map<string, LoreFileStatus>();
  for (const entry of [...status.untracked, ...status.unstaged, ...status.staged]) {
    byPath.set(entry.path, entry);
  }
  return byPath;
}

// Composes the compare result with the working-tree status into the file list
// rows. Diff order is preserved; a file absent from status (e.g. a
// revision→revision compare with no working-tree entry) is simply not staged
// and not conflicted.
export function composeReviewFiles(
  diffs: readonly FileDiffResult[],
  status: LoreFileStatusGroup
): ReviewFile[] {
  const byPath = indexStatus(status);
  return diffs.map(diff => {
    const fileStatus = byPath.get(diff.path);
    return {
      path: diff.path,
      action: diff.action,
      lineStats: diff.lineStats,
      binary: diff.binary,
      truncated: diff.truncated,
      patch: diff.patch,
      staged: fileStatus?.isStaged ?? false,
      conflictUnresolved: fileStatus?.conflictUnresolved ?? false,
    };
  });
}

// Sums per-file line stats into the file-list header's aggregate (+X −Y).
export function totalLineStats(files: readonly ReviewFile[]): LineStats {
  return files.reduce<LineStats>(
    (acc, file) => ({
      added: acc.added + (file.lineStats?.added ?? 0),
      removed: acc.removed + (file.lineStats?.removed ?? 0),
    }),
    { added: 0, removed: 0 }
  );
}

export type DiffLineKind = 'context' | 'add' | 'del';

// The added/removed background tones shared by the diff pane and the conflict
// block's side columns: themeable CSS variables with the design-2b oklch
// values as fallbacks, defined once so the two surfaces cannot drift.
export const DIFF_TONE_BG = {
  add: 'var(--diff-add, oklch(0.94 0.045 145))',
  del: 'var(--diff-del, oklch(0.94 0.035 25))',
} as const;

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  // The line number in the target (new) file for context/added lines; the
  // source (old) file line for removed lines. Undefined only when the hunk
  // header could not be parsed.
  readonly lineNo: number | undefined;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Parses a unified-diff patch into hunks with per-line numbering, discarding
// the file header lines (---/+++). Only the selected file's patch is ever
// parsed, so large diffs stay cheap (only the selected file renders).
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: { header: string; lines: DiffLine[]; oldNo: number; newNo: number } | null = null;

  for (const line of patch.split('\n')) {
    const headerMatch = HUNK_HEADER.exec(line);
    if (headerMatch) {
      current = {
        header: line,
        lines: [],
        oldNo: Number(headerMatch[1]),
        newNo: Number(headerMatch[2]),
      };
      hunks.push({ header: line, lines: current.lines });
      continue;
    }
    if (!current) {
      // Pre-hunk file headers (--- a/x, +++ b/x) and any preamble are skipped.
      continue;
    }
    if (line === '') {
      // Trailing artifact from splitting a patch that ends in a newline; a
      // genuine blank context line is encoded as a single leading space.
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1), lineNo: current.newNo });
      current.newNo += 1;
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', text: line.slice(1), lineNo: current.oldNo });
      current.oldNo += 1;
    } else {
      // Context line (leading space) or a trailing empty split artifact.
      current.lines.push({ kind: 'context', text: line.replace(/^ /, ''), lineNo: current.newNo });
      current.oldNo += 1;
      current.newNo += 1;
    }
  }
  return hunks;
}
