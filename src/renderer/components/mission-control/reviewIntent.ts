import type {
  CompareTarget,
  ReviewCompare,
  ReviewOpenRequest,
  ReviewWorkflowMode,
  Workspace,
} from '../../../shared/types';

// A typed "open the review window" request. Mission Control's Review / Commit /
// Merge buttons emit one of these; requestOpenReviewWindow (P11) translates it
// into the ReviewOpenRequest the review window consumes with its targets +
// workflow preloaded (design 2a: "buttons preload its targets and workflow").
export interface OpenReviewIntent {
  readonly workspace: Workspace;
  readonly workflow: ReviewWorkflowMode;
}

// The compare picker's initial selection. Commit review diffs the workspace's
// current revision against its working tree (design 2b: "r128 → working tree");
// when the revision is unknown it falls back to the branch head. Merge review
// diffs the branch against main (design 2c); the picker refetches from there.
function buildCompare(workflow: ReviewWorkflowMode, workspace: Workspace): ReviewCompare {
  if (workflow === 'merge') {
    return {
      source: { kind: 'branchHead', branch: workspace.branchName },
      target: { kind: 'branchHead', branch: 'main' },
    };
  }
  const source: CompareTarget =
    workspace.revision.length > 0
      ? { kind: 'revision', revision: workspace.revision }
      : { kind: 'branchHead', branch: workspace.branchName };
  return { source, target: { kind: 'workingTree' } };
}

// Opens (or re-targets) the review window over the given workspace. The
// workspace's checkout path is the repositoryPath every diff/status/stage/
// commit call in the window targets.
export function requestOpenReviewWindow(intent: OpenReviewIntent): void {
  const { workspace, workflow } = intent;
  const request: ReviewOpenRequest = {
    workspacePath: workspace.path,
    repositoryId: workspace.repositoryId,
    branchName: workspace.branchName,
    revision: workspace.revision,
    workflow,
    compare: buildCompare(workflow, workspace),
  };
  window.electronAPI.review.open(request);
}
