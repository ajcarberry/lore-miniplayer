import type { ReactElement } from 'react';
import { Stack } from '@mantine/core';
import type { ReviewOpenRequest, ReviewWorkflowMode } from '../../../shared/types';
import { CommitReview } from './CommitReview';
import { MergeView } from './MergeView';

export interface ProjectViewProps {
  readonly request: ReviewOpenRequest;
  // Morph back to the card.
  readonly onExit: () => void;
  // Collapse all the way to the ambient pill.
  readonly onCollapse: () => void;
  // Re-open the view with the other workflow (the header switcher).
  readonly onSwitchWorkflow: (workflow: ReviewWorkflowMode) => void;
  // Whether the merge workflow applies at all (distinct target with
  // revisions to land); the commit view additionally gates on staged files.
  readonly mergeAvailable: boolean;
}

// The Project View the card morphs into: routes the open request by
// workflow — commit review and merge each own a view (including its TitleBar,
// so the merge can gate the collapse control behind its discard
// confirmation). Keyed on the request so a re-open with different targets
// remounts the view with fresh seeded state.
export function ProjectView({
  request,
  onExit,
  onCollapse,
  onSwitchWorkflow,
  mergeAvailable,
}: ProjectViewProps): ReactElement {
  const key = JSON.stringify(request);
  return (
    <Stack gap={0} h='100%' style={{ background: 'var(--paper)' }}>
      {request.workflow === 'merge' ? (
        <MergeView
          key={key}
          request={request}
          onExit={onExit}
          onCollapse={onCollapse}
          onSwitchWorkflow={onSwitchWorkflow}
        />
      ) : (
        <CommitReview
          key={key}
          request={request}
          onExit={onExit}
          onCollapse={onCollapse}
          onSwitchWorkflow={onSwitchWorkflow}
          mergeAvailable={mergeAvailable}
        />
      )}
    </Stack>
  );
}
