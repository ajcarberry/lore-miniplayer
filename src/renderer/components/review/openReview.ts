import type {
  CompareTarget,
  Repository,
  ReviewCompare,
  ReviewOpenRequest,
  ReviewWorkflowMode,
} from '../../../shared/types';

// A typed "open the review window" request. The card view's Review / Merge
// actions emit one of these; requestOpenReviewWindow translates it into the
// ReviewOpenRequest the review window consumes with its targets + workflow
// preloaded.
export interface OpenReviewIntent {
  readonly repository: Repository;
  readonly branchName: string;
  // The working copy's current revision ('' when unknown).
  readonly currentRevision: string;
  // The merge workflow's landing target (the parent lane / default branch).
  readonly targetBranch: string;
  readonly workflow: ReviewWorkflowMode;
}

// The compare picker's initial selection. Commit review diffs the current
// revision against the working tree; when the revision is unknown it falls
// back to the branch head. Merge review diffs the branch against its target;
// the picker refetches from there.
function buildCompare(intent: OpenReviewIntent): ReviewCompare {
  if (intent.workflow === 'merge') {
    return {
      source: { kind: 'branchHead', branch: intent.branchName },
      target: { kind: 'branchHead', branch: intent.targetBranch },
    };
  }
  const source: CompareTarget =
    intent.currentRevision.length > 0
      ? { kind: 'revision', revision: intent.currentRevision }
      : { kind: 'branchHead', branch: intent.branchName };
  return { source, target: { kind: 'workingTree' } };
}

// The repository's local path is the repositoryPath every diff/status/stage/
// commit call in the review window targets.
export function buildReviewOpenRequest(intent: OpenReviewIntent): ReviewOpenRequest {
  return {
    repositoryPath: intent.repository.localPath,
    repositoryId: intent.repository.id,
    branchName: intent.branchName,
    workflow: intent.workflow,
    compare: buildCompare(intent),
  };
}

// Opens (or re-targets) the review window over the given repository.
export function requestOpenReviewWindow(intent: OpenReviewIntent): void {
  window.electronAPI.review.open(buildReviewOpenRequest(intent));
}
