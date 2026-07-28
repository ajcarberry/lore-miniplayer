import { buildReviewOpenRequest } from '../../../src/renderer/components/review/openReview';
import type { OpenReviewIntent } from '../../../src/renderer/components/review/openReview';
import { REPO_ID } from './fixtures';
import type { Repository } from '../../../src/shared/types';

const repository = {
  id: REPO_ID,
  name: 'emberfall',
  url: 'lore.example.com/emberfall',
  localPath: '/repos/emberfall',
  accentHue: 74,
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:00.000Z',
} as Repository;

function makeIntent(overrides: Partial<OpenReviewIntent> = {}): OpenReviewIntent {
  return {
    repository,
    branchName: 'feat/topic',
    currentRevision: 'r128',
    targetBranch: 'main',
    workflow: 'commit',
    ...overrides,
  };
}

describe('buildReviewOpenRequest', () => {
  it('builds a commit request diffing the current revision against the working tree', () => {
    // When: building the commit-workflow request with a known revision
    const request = buildReviewOpenRequest(makeIntent());

    // Then: the repository is addressed by its local path and the compare
    // preloads current revision → working tree
    expect(request).toEqual({
      repositoryPath: '/repos/emberfall',
        repositoryName: 'emberfall',
      branchName: 'feat/topic',
      targetBranch: 'main',
      workflow: 'commit',
      compare: {
        source: { kind: 'revision', revision: 'r128' },
        target: { kind: 'workingTree' },
      },
    });
  });

  it('falls back to the branch head when the current revision is unknown', () => {
    // When: building the commit-workflow request with no revision
    const request = buildReviewOpenRequest(makeIntent({ currentRevision: '' }));

    // Then: the source degrades to the branch head
    expect(request.compare.source).toEqual({ kind: 'branchHead', branch: 'feat/topic' });
    expect(request.compare.target).toEqual({ kind: 'workingTree' });
  });

  it('builds a merge request diffing the branch head against the target branch head', () => {
    // When: building the merge-workflow request
    const request = buildReviewOpenRequest(makeIntent({ workflow: 'merge' }));

    // Then: the compare preloads branch → target for the merge view
    expect(request.workflow).toBe('merge');
    expect(request.compare).toEqual({
      source: { kind: 'branchHead', branch: 'feat/topic' },
      target: { kind: 'branchHead', branch: 'main' },
    });
  });
});
