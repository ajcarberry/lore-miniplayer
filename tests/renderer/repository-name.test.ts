import {
  distinctWorkspaceName,
  groupWorkspacesByRepo,
  repoEyebrowLabel,
  repoNameFromUrl,
  workspaceDisplayName,
} from '../../src/renderer/utils/repository-name';
import { makeRepository } from '../mocks/repository-fixture';

describe('repoNameFromUrl', () => {
  it('extracts the last path segment from a Lore scheme url', () => {
    // Given/When/Then: the repo name is the final path component
    expect(repoNameFromUrl('lores://lore.example.com/demo-project')).toBe('demo-project');
    expect(repoNameFromUrl('lore://lore.example.com:8080/team/demo-project')).toBe('demo-project');
  });

  it('extracts the last path segment from a schemeless domain/repo url', () => {
    // Given/When/Then: the same derivation applies without a scheme
    expect(repoNameFromUrl('lore.example.com/demo-project')).toBe('demo-project');
  });

  it('falls back to the whole url when there is no path segment', () => {
    // Given/When/Then: an unparseable url is returned unchanged rather than
    // throwing or returning an empty string
    expect(repoNameFromUrl('local://existing')).toBe('existing');
  });
});

describe('workspaceDisplayName', () => {
  it('shows the plain name for attached and cloned workspaces', () => {
    // Given: card-view entries (not provisioned)
    const attached = makeRepository({ origin: 'attached', name: 'MyRepo' });
    const cloned = makeRepository({ origin: 'cloned', name: 'ClonedRepo' });

    // Then: the display name is just the registry name
    expect(workspaceDisplayName(attached)).toBe('MyRepo');
    expect(workspaceDisplayName(cloned)).toBe('ClonedRepo');
  });

  it('shows the branch name for a provisioned workspace, without a repo prefix', () => {
    // Given: a provisioned worktree whose branchName is the branch it checked
    // out (the registry `name` mirrors it but is regex-restricted, so
    // display prefers `branchName` — see RepositorySchema.name). The repo
    // prefix this util used to add is now carried by the footer's own
    // grouping (Menu.Label per repo), so this stays workspace-identity-only.
    const provisioned = makeRepository({
      origin: 'provisioned',
      name: 'test-WT1',
      url: 'lores://lore.example.com/demo-project',
      branchName: 'test/WT1',
    });

    // Then: the display name is just the branch-like identity
    expect(workspaceDisplayName(provisioned)).toBe('test/WT1');
  });
});

describe('repoEyebrowLabel', () => {
  it('shows just the repo name when the workspace name is redundant with it', () => {
    // Given: a primary checkout named like its repo (the common case)
    const primary = makeRepository({
      name: 'demo-project',
      url: 'lores://lore.example.com/demo-project',
    });

    // Then: no combined label — the repo name alone is shown
    expect(repoEyebrowLabel(primary, 'main')).toBe('demo-project');
  });

  it('shows just the repo name when the workspace name is redundant with the current branch', () => {
    // Given: a provisioned worktree whose sanitized name reads as its branch
    // (slashes replaced with hyphens), and the live branch matches it
    const provisioned = makeRepository({
      origin: 'provisioned',
      name: 'test-WT1',
      url: 'lores://lore.example.com/demo-project',
      branchName: 'test/WT1',
    });

    // Then: still just the repo name — the workspace name adds nothing over
    // the branch line already shown below it
    expect(repoEyebrowLabel(provisioned, 'test/WT1')).toBe('demo-project');
  });

  it('combines repo name and workspace name when the workspace name is meaningfully different', () => {
    // Given: an attached sibling workspace named "adfa" of repo "demo-project",
    // currently on a branch that is neither "adfa" nor "demo-project"
    const attached = makeRepository({
      name: 'adfa',
      url: 'lores://lore.example.com/demo-project',
    });

    // Then: both identities show, repo first
    expect(repoEyebrowLabel(attached, 'main')).toBe('demo-project · adfa');
  });

  it('ignores case and punctuation differences when judging redundancy', () => {
    // Given: a workspace name that differs from the repo name only in case
    // and separators
    const primary = makeRepository({
      name: 'Demo Project',
      url: 'lores://lore.example.com/demo-project',
    });

    // Then: still treated as redundant — no combined label
    expect(repoEyebrowLabel(primary, 'main')).toBe('demo-project');
  });
});

describe('distinctWorkspaceName', () => {
  it('returns the name when it is meaningfully different from the branch', () => {
    // Given: two attached workspaces of one repo both checked out to a
    // branch named "adfa" but registered under distinct names
    expect(distinctWorkspaceName('personal-test', 'adfa')).toBe('personal-test');
  });

  it('returns undefined when the name is redundant with the branch', () => {
    // Given: a provisioned worktree's registry name is a sanitized version
    // of its branch (slashes replaced with hyphens)
    expect(distinctWorkspaceName('test-WT1', 'test/WT1')).toBeUndefined();
  });

  it('ignores case and punctuation differences when judging redundancy', () => {
    expect(distinctWorkspaceName('Agent Act2 Balance', 'agent/act2-balance')).toBeUndefined();
  });
});

describe('groupWorkspacesByRepo', () => {
  it('groups workspaces sharing a loreRepositoryId even if their urls differ', () => {
    // Given: two entries with the same resolved repo id but drifted urls
    // (e.g. one healed, one not yet)
    const a = makeRepository({
      id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
      name: 'main',
      url: 'lores://lore.example.com/demo-project',
      loreRepositoryId: 'repo-1',
    });
    const b = makeRepository({
      id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
      name: 'adfa',
      url: 'local://existing',
      loreRepositoryId: 'repo-1',
    });

    // When: grouping
    const groups = groupWorkspacesByRepo([a, b]);

    // Then: a single group holds both, keyed by the shared id
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('repo-1');
    expect(groups[0]?.workspaces).toEqual([a, b]);
  });

  it('falls back to url as the grouping key when loreRepositoryId is absent', () => {
    // Given: two entries for the same url, neither with a resolved id
    const a = makeRepository({
      id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
      name: 'main',
      url: 'lores://lore.example.com/demo-project',
    });
    const b = makeRepository({
      id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
      origin: 'provisioned',
      name: 'test-WT1',
      url: 'lores://lore.example.com/demo-project',
      branchName: 'test/WT1',
    });

    // When: grouping
    const groups = groupWorkspacesByRepo([a, b]);

    // Then: one group, keyed by the shared url
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('lores://lore.example.com/demo-project');
    expect(groups[0]?.workspaces).toEqual([a, b]);
  });

  it('union-merges an entry with only a url and a sibling with the same url + id (the false-split fix)', () => {
    // Given: the exact mixed-key case from the field report — the original
    // attach entry carries only a url, its healed sibling carries the same url
    // AND a resolved id. Per-entry `id ?? url` keying would split them (one
    // keyed by url, one by id); a union over BOTH keys must keep them together.
    const original = makeRepository({
      id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
      name: 'demo-project',
      url: 'lores://lore.example.com/demo-project',
    });
    const healed = makeRepository({
      id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
      name: 'adfa',
      url: 'lores://lore.example.com/demo-project',
      loreRepositoryId: 'repo-1',
    });

    // When: grouping
    const groups = groupWorkspacesByRepo([original, healed]);

    // Then: ONE group, keyed by the resolved id a member carries, holding both
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('repo-1');
    expect(groups[0]?.workspaces).toEqual([original, healed]);
  });

  it('union-merges two entries linked by a shared id even when their urls differ', () => {
    // Given: A has url1 + id; B has a different url2 but the same id — the id
    // bridges them regardless of url drift
    const a = makeRepository({
      id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
      name: 'main',
      url: 'lores://lore.example.com/demo-project',
      loreRepositoryId: 'repo-1',
    });
    const b = makeRepository({
      id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
      name: 'adfa',
      url: 'local://existing',
      loreRepositoryId: 'repo-1',
    });

    // When: grouping
    const groups = groupWorkspacesByRepo([a, b]);

    // Then: one group keyed by the shared id
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('repo-1');
    expect(groups[0]?.workspaces).toEqual([a, b]);
  });

  it('keeps unrelated repos in separate groups, in first-seen order', () => {
    // Given: two entirely different repos
    const first = makeRepository({
      id: '4f8f2c9e-4b1f-4b7e-9a1a-1c2d3e4f5a6b',
      name: 'MyRepo',
      url: 'lores://lore.example.com/my-repo',
    });
    const second = makeRepository({
      id: '5a9d3c8f-6c2e-4d8f-8b2b-2d3e4f5a6b7c',
      name: 'OtherRepo',
      url: 'lores://lore.example.com/other-repo',
    });

    // When: grouping
    const groups = groupWorkspacesByRepo([first, second]);

    // Then: two groups, each with the right repo name and one workspace
    expect(groups.map(g => g.repoName)).toEqual(['my-repo', 'other-repo']);
    expect(groups[0]?.workspaces).toEqual([first]);
    expect(groups[1]?.workspaces).toEqual([second]);
  });
});
