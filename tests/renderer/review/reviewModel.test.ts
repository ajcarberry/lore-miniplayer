import {
  compareTargetLabel,
  composeReviewFiles,
  parseHunks,
  totalLineStats,
} from '../../../src/renderer/components/review/reviewModel';
import type { FileDiffResult, LoreFileStatusGroup } from '../../../src/shared/types';

function diff(overrides: Partial<FileDiffResult> = {}): FileDiffResult {
  return {
    path: 'encounters.toml',
    action: 'modified',
    patch: '',
    binary: false,
    truncated: false,
    lineStats: { added: 14, removed: 9 },
    ...overrides,
  };
}

function emptyStatus(): LoreFileStatusGroup {
  return { untracked: [], unstaged: [], staged: [] };
}

describe('composeReviewFiles', () => {
  it('marks a file staged when it appears in the status staged group', () => {
    // Given: a diff whose file is staged in the working-tree status
    const status: LoreFileStatusGroup = {
      untracked: [],
      unstaged: [],
      staged: [{ path: 'encounters.toml', isUntracked: false, isStaged: true, conflict: false }],
    };

    // When: composing the review file list
    const [file] = composeReviewFiles([diff()], status);

    // Then: the row reports staged and not conflicted
    expect(file).toMatchObject({
      path: 'encounters.toml',
      staged: true,
      conflictUnresolved: false,
    });
  });

  it('flags an unresolved conflict from the unstaged group', () => {
    // Given: a diff whose file is a still-unresolved conflict
    const status: LoreFileStatusGroup = {
      untracked: [],
      unstaged: [
        {
          path: 'encounters.toml',
          isUntracked: false,
          isStaged: false,
          conflict: true,
          conflictUnresolved: true,
        },
      ],
      staged: [],
    };

    // When/Then: the composed row carries the unresolved flag
    expect(composeReviewFiles([diff()], status)[0]!.conflictUnresolved).toBe(true);
  });

  it('leaves a file with no status entry unstaged and unconflicted', () => {
    // When: composing a diff whose file has no working-tree status
    const [file] = composeReviewFiles([diff({ path: 'orphan.toml' })], emptyStatus());

    // Then: it is neither staged nor conflicted
    expect(file).toMatchObject({ staged: false, conflictUnresolved: false });
  });
});

describe('totalLineStats', () => {
  it('sums added and removed across files, treating binaries (no stats) as zero', () => {
    // When: totalling a modified file plus a binary with no stats
    const files = composeReviewFiles(
      [diff(), diff({ path: 'loot.bin', binary: true, lineStats: undefined })],
      emptyStatus()
    );

    // Then: only the counted file contributes
    expect(totalLineStats(files)).toEqual({ added: 14, removed: 9 });
  });
});

describe('compareTargetLabel', () => {
  it('labels each compare target kind', () => {
    expect(compareTargetLabel({ kind: 'revision', revision: 'r128' })).toBe('r128');
    expect(compareTargetLabel({ kind: 'workingTree' })).toBe('working tree');
    expect(compareTargetLabel({ kind: 'branchHead', branch: 'main' })).toBe('main');
  });
});

describe('parseHunks', () => {
  const patch =
    '--- a.txt@1\n' +
    '+++ a.txt\n' +
    '@@ -38,3 +38,4 @@ [enc.ravine]\n' +
    ' [enc.ravine.ambush]\n' +
    '-elite_count = 2\n' +
    '+elite_count = 4\n' +
    '+elite_spawn_delay = 6.0\n';

  it('discards the file header and returns one hunk with its header line', () => {
    // When: parsing the patch
    const hunks = parseHunks(patch);

    // Then: exactly one hunk, carrying its @@ header
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.header).toBe('@@ -38,3 +38,4 @@ [enc.ravine]');
  });

  it('classifies context, deletions, and additions with running line numbers', () => {
    // When: parsing the patch's hunk lines
    const { lines } = parseHunks(patch)[0]!;

    // Then: each line is classified and numbered from the hunk header
    expect(lines).toEqual([
      { kind: 'context', text: '[enc.ravine.ambush]', lineNo: 38 },
      { kind: 'del', text: 'elite_count = 2', lineNo: 39 },
      { kind: 'add', text: 'elite_count = 4', lineNo: 39 },
      { kind: 'add', text: 'elite_spawn_delay = 6.0', lineNo: 40 },
    ]);
  });

  it('returns no hunks for an empty patch', () => {
    // When/Then: an empty patch yields no hunks and no trailing artifact line
    expect(parseHunks('')).toEqual([]);
  });
});
