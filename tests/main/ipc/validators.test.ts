import {
  LoreFilePathsArgsSchema,
  PathJoinInputSchema,
  PathBasenameInputSchema,
  WorkspaceModelRefreshArgsSchema,
} from '../../../src/main/ipc/validators';

describe('Path input schemas', () => {
  it('should require at least one segment for join', () => {
    // When: parsing an empty segments array
    const result = PathJoinInputSchema.safeParse({ segments: [] });

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should accept a non-empty segments array', () => {
    // When: parsing segments
    const result = PathJoinInputSchema.safeParse({ segments: ['/a', 'b'] });

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should require a non-empty path for basename', () => {
    // When: parsing paths
    // Then: an empty path is rejected and a real one accepted
    expect(PathBasenameInputSchema.safeParse({ path: '' }).success).toBe(false);
    expect(PathBasenameInputSchema.safeParse({ path: '/ok' }).success).toBe(true);
  });
});

describe('LoreFilePathsArgsSchema (stage/unstage)', () => {
  const repo = '/repos/project';

  it('should accept repository-relative file paths', () => {
    // When: parsing normal relative paths, including nested ones
    const result = LoreFilePathsArgsSchema.safeParse([repo, ['src/index.ts', 'docs/readme.md']]);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject file paths that traverse out of the repository', () => {
    // When: parsing a path with a parent-directory segment
    // Then: both separator styles are rejected
    expect(LoreFilePathsArgsSchema.safeParse([repo, ['../outside.txt']]).success).toBe(false);
    expect(LoreFilePathsArgsSchema.safeParse([repo, ['src/../../etc/passwd']]).success).toBe(false);
    expect(LoreFilePathsArgsSchema.safeParse([repo, ['..\\outside.txt']]).success).toBe(false);
  });

  it('should reject absolute file paths', () => {
    // When: parsing absolute POSIX and Windows paths
    // Then: parsing fails — file paths must stay repository-relative
    expect(LoreFilePathsArgsSchema.safeParse([repo, ['/etc/passwd']]).success).toBe(false);
    expect(LoreFilePathsArgsSchema.safeParse([repo, ['C:\\Windows\\system32']]).success).toBe(
      false
    );
  });

  it('should reject empty file paths', () => {
    // When: parsing an empty string entry
    const result = LoreFilePathsArgsSchema.safeParse([repo, ['']]);

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should accept a filename that merely contains dots', () => {
    // When: parsing lookalike names that are not traversal
    const result = LoreFilePathsArgsSchema.safeParse([repo, ['notes..txt', 'a..b/file.ts']]);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });
});

describe('WorkspaceModelRefreshArgsSchema (workspace:model:refresh)', () => {
  const repositoryId = '11111111-1111-4111-8111-111111111111';

  it('should accept a single valid repository id', () => {
    // When: parsing a well-formed repository id tuple
    const result = WorkspaceModelRefreshArgsSchema.safeParse([repositoryId]);

    // Then: parsing succeeds
    expect(result.success).toBe(true);
  });

  it('should reject a malformed repository id', () => {
    // When: parsing a non-uuid string
    const result = WorkspaceModelRefreshArgsSchema.safeParse(['not-a-uuid']);

    // Then: parsing fails
    expect(result.success).toBe(false);
  });

  it('should reject a missing repository id', () => {
    // When: parsing an empty argument tuple
    const result = WorkspaceModelRefreshArgsSchema.safeParse([]);

    // Then: parsing fails
    expect(result.success).toBe(false);
  });
});
