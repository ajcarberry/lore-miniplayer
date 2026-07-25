import type { ReviewOpenRequest } from '../../../src/shared/types';
import { REPO_ID } from '../mission-control/fixtures';

export function makeReviewRequest(overrides: Partial<ReviewOpenRequest> = {}): ReviewOpenRequest {
  return {
    workspacePath: '/wt/act2-balance',
    repositoryId: REPO_ID,
    branchName: 'agent/act2-balance',
    workflow: 'commit',
    compare: {
      source: { kind: 'revision', revision: 'r128' },
      target: { kind: 'workingTree' },
    },
    ...overrides,
  };
}
