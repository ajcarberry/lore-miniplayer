import { useEffect, useState } from 'react';
import type { RevisionSummary } from '../../../shared/types';

export interface ReviewMeta {
  readonly repositoryName: string | null;
  readonly revisions: RevisionSummary[];
}

// Resolves the repo name for the review header's eyebrow and loads the
// branch's revisions (the commit workflow's compare-picker options / the merge
// workflow's "merging commits"). Shared by both review workflows; both fetches
// set state only inside their resolved promises.
export function useReviewMeta(
  repositoryPath: string,
  repositoryId: string,
  branchName: string
): ReviewMeta {
  const [repositoryName, setRepositoryName] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);

  useEffect(() => {
    void window.electronAPI.repository.list().then(result => {
      if (result.success) {
        setRepositoryName(result.data.find(repo => repo.id === repositoryId)?.name ?? null);
      }
    });
    void window.electronAPI.lore.branchGraph(repositoryPath, branchName).then(result => {
      if (result.success) {
        setRevisions(result.data.branch.revisions);
      }
    });
  }, [repositoryPath, repositoryId, branchName]);

  return { repositoryName, revisions };
}
