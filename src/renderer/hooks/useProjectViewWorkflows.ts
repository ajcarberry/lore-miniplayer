import { useCallback } from 'react';
import type { Repository, ReviewOpenRequest, ReviewWorkflowMode } from '../../shared/types';
import type { BranchesState } from './useBranches';
import type { BranchGraphState } from './useBranchGraph';
import { buildReviewOpenRequest } from '../components/review/openReview';
import { resolveMergeTarget } from '../components/SyncView';
import { useRevisionsToLand } from './useRevisionsToLand';

export interface ProjectViewWorkflows {
  // The merge workflow's landing target (parent lane / default branch).
  readonly mergeTarget: string;
  // The merge service's ancestry predicate for the current branch vs target.
  readonly hasRevisionsToLand: boolean;
  // Whether the merge workflow applies at all: a distinct target with
  // revisions to land. (The commit view additionally gates on staged files.)
  readonly mergeAvailable: boolean;
  // Re-open the Project View with the given workflow, rebuilt from the
  // card's live context (the header switcher).
  readonly switchWorkflow: (workflow: ReviewWorkflowMode) => void;
}

export function useProjectViewWorkflows(
  selectedRepo: Repository | null,
  branches: BranchesState,
  graph: BranchGraphState,
  isConnected: boolean,
  openProjectView: (request: ReviewOpenRequest) => void
): ProjectViewWorkflows {
  const mergeTarget = resolveMergeTarget(graph.graph.parent?.name, branches.branches);
  const currentRevision = graph.graph.current;
  const tipRevision = graph.graph.branch.revisions[0]?.revision ?? '';
  const { hasRevisionsToLand } = useRevisionsToLand(
    selectedRepo,
    branches.currentBranch,
    mergeTarget,
    isConnected,
    tipRevision
  );

  const switchWorkflow = useCallback(
    (workflow: ReviewWorkflowMode): void => {
      if (selectedRepo) {
        openProjectView(
          buildReviewOpenRequest({
            repository: selectedRepo,
            branchName: branches.currentBranch,
            currentRevision,
            targetBranch: mergeTarget,
            workflow,
          })
        );
      }
    },
    [selectedRepo, branches.currentBranch, currentRevision, mergeTarget, openProjectView]
  );

  return {
    mergeTarget,
    hasRevisionsToLand,
    mergeAvailable: hasRevisionsToLand && mergeTarget !== branches.currentBranch,
    switchWorkflow,
  };
}
