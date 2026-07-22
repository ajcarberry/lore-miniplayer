import { repoNameFromUrl, workspaceDisplayName } from '../../src/renderer/utils/repository-name';
import { makeRepository } from '../mocks/repository-fixture';

describe('repoNameFromUrl', () => {
  it('extracts the last path segment from a Lore scheme url', () => {
    // Given/When/Then: the repo name is the final path component
    expect(repoNameFromUrl('lores://lore.example.com/demo-project')).toBe('demo-project');
    expect(repoNameFromUrl('lore://lore.example.com:8080/team/demo-project')).toBe(
      'demo-project'
    );
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

  it('prefixes a provisioned workspace with its url-derived repo name', () => {
    // Given: a provisioned worktree whose branchName is the branch it checked
    // out (the registry `name` mirrors it but is regex-restricted, so
    // display prefers `branchName` — see RepositorySchema.name)
    const provisioned = makeRepository({
      origin: 'provisioned',
      name: 'test-WT1',
      url: 'lores://lore.example.com/demo-project',
      branchName: 'test/WT1',
    });

    // Then: the display name reads "<repo name> · <branch-like name>"
    expect(workspaceDisplayName(provisioned)).toBe('demo-project · test/WT1');
  });
});
