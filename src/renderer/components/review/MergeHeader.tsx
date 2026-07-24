import type { ReactElement } from 'react';
import { IconGitMerge } from '@tabler/icons-react';
import { pluralize } from '../../utils/pluralize';
import { ReviewHeader } from './ReviewHeader';

export interface MergeHeaderProps {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly repositoryName: string | null;
  readonly commitCount: number;
  readonly conflictCount: number;
}

// The eyebrow: "<repo> · N commits · M conflicts".
function formatEyebrow(
  repositoryName: string | null,
  commitCount: number,
  conflictCount: number
): string {
  const commits = `${commitCount} ${pluralize(commitCount, 'commit')}`;
  const conflicts = `${conflictCount} ${pluralize(conflictCount, 'conflict')}`;
  return `${repositoryName ? `${repositoryName} · ` : ''}${commits} · ${conflicts}`;
}

// The review window's merge header (design 2c): "Merge — <branch> → <target>"
// with a commit/conflict tally eyebrow, on the shared header shell.
export function MergeHeader(props: MergeHeaderProps): ReactElement {
  return (
    <ReviewHeader
      title={`Merge — ${props.sourceBranch} → ${props.targetBranch}`}
      eyebrow={formatEyebrow(props.repositoryName, props.commitCount, props.conflictCount)}
      icon={<IconGitMerge size={18} color='var(--acc-deep, #7a5b1e)' />}
    />
  );
}
