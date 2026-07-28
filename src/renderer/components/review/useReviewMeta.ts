import { useEffect, useState } from 'react';
import type { RevisionSummary } from '../../../shared/types';

export interface ReviewMeta {
  readonly revisions: RevisionSummary[];
  // The fork revision on the parent branch, when the graph resolves one —
  // lets the merge workflow show only the branch's own commits.
  readonly parentBranchPoint: string | undefined;
}

// Loads the branch's revisions (the commit workflow's compare-picker options /
// the merge workflow's "merging commits") and the fork point. Shared by both
// review workflows.
export function useReviewMeta(repositoryPath: string, branchName: string): ReviewMeta {
  const [meta, setMeta] = useState<ReviewMeta>({ revisions: [], parentBranchPoint: undefined });

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.lore.branchGraph(repositoryPath, branchName).then(result => {
      if (!cancelled && result.success) {
        setMeta({
          revisions: result.data.branch.revisions,
          parentBranchPoint: result.data.parent?.branchPoint,
        });
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [repositoryPath, branchName]);

  return meta;
}
