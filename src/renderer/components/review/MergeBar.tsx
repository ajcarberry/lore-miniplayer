import type { ReactElement } from 'react';
import { Button, Text } from '@mantine/core';
import { ReviewBottomBar } from './ReviewBottomBar';

export interface MergeBarProps {
  readonly conflictCount: number;
  readonly resolvedCount: number;
  readonly allResolved: boolean;
  // Whether the branch has commits the target lacks. Gates Merge independently
  // of conflict resolution: a fully-resolved (or conflict-free) merge whose
  // branch is not ahead has nothing to land.
  readonly hasChangesToLand: boolean;
  readonly completing: boolean;
  readonly landedRevision: string | null;
  readonly targetBranch: string;
  readonly onAbort: () => void;
  readonly onMerge: () => void;
}

// The merge workflow's bottom bar: the
// resolved/total conflict tally, the affordance note that the merge lands on
// the target, and the single contextual primary action. Merge is gated until every conflict is
// resolved; once it lands, the actions give way to the landed-revision line.
export function MergeBar(props: MergeBarProps): ReactElement {
  const {
    conflictCount,
    resolvedCount,
    allResolved,
    hasChangesToLand,
    completing,
    landedRevision,
    targetBranch,
  } = props;

  const tally =
    conflictCount === 0
      ? hasChangesToLand
        ? 'No conflicts to resolve'
        : 'Nothing to land'
      : `${resolvedCount} of ${conflictCount} conflicts resolved`;

  return (
    <ReviewBottomBar tally={tally}>
      <Text size='xs' c='dimmed' truncate style={{ flex: 1, minWidth: 0 }}>
        Merge commits land on {targetBranch}
      </Text>
      {landedRevision === null ? (
        <>
          <Button size='sm' variant='subtle' color='red' onClick={props.onAbort}>
            Abort
          </Button>
          <Button
            size='sm'
            loading={completing}
            disabled={!allResolved || !hasChangesToLand || completing}
            onClick={props.onMerge}
          >
            Merge
          </Button>
        </>
      ) : (
        <Text size='sm' fw={600} c='green' style={{ whiteSpace: 'nowrap' }}>
          {`Landed ${landedRevision} on ${targetBranch}`}
        </Text>
      )}
    </ReviewBottomBar>
  );
}
