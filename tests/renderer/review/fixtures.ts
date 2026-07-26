import type { ReviewOpenRequest } from '../../../src/shared/types';

export const REPO_ID = '7b1a4c1e-9d2f-4e5a-8c3b-2f1e0d9c8b7a';

export function makeReviewRequest(overrides: Partial<ReviewOpenRequest> = {}): ReviewOpenRequest {
  return {
    repositoryPath: '/repos/my-repo',
    repositoryId: REPO_ID,
    branchName: 'feat/topic',
    workflow: 'commit',
    compare: {
      source: { kind: 'revision', revision: 'r128' },
      target: { kind: 'workingTree' },
    },
    ...overrides,
  };
}
