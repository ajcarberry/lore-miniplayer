import type { ReactElement } from 'react';
import { SegmentedControl } from '@mantine/core';
import type { ReviewWorkflowMode } from '../../../shared/types';

export interface WorkflowSwitchProps {
  readonly workflow: ReviewWorkflowMode;
  // Whether the merge workflow can be entered at all: the branch carries
  // revisions its target lacks, the target is a distinct branch, AND nothing
  // is staged — the merge pre-flight refuses staged files.
  readonly mergeEnabled: boolean;
  readonly onSwitch: (workflow: ReviewWorkflowMode) => void;
}

// The Project View's workflow switcher, rendered in both workflow headers so
// the card needs only one entry point.
export function WorkflowSwitch({
  workflow,
  mergeEnabled,
  onSwitch,
}: WorkflowSwitchProps): ReactElement {
  return (
    <SegmentedControl
      size='xs'
      value={workflow}
      onChange={value => {
        if (value !== workflow && (value === 'commit' || value === 'merge')) {
          onSwitch(value);
        }
      }}
      data={[
        { label: 'Review', value: 'commit' },
        { label: 'Merge', value: 'merge', disabled: !mergeEnabled },
      ]}
    />
  );
}
