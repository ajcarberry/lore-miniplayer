import type { ReactElement } from 'react';
import { Stack } from '@mantine/core';
import type { ReviewOpenRequest } from '../../../shared/types';
import { TitleBar } from '../TitleBar';
import { CommitReview } from './CommitReview';
import { MergeView } from './MergeView';

export interface ProjectViewProps {
  readonly request: ReviewOpenRequest;
  // Morph back to the card.
  readonly onExit: () => void;
  // Collapse all the way to the ambient pill.
  readonly onCollapse: () => void;
}

// The Project View the card morphs into: routes the open request by
// workflow — commit review and merge each own a view. Keyed on the request so
// a re-open with different targets remounts the view with fresh seeded state.
// The TitleBar's collapse control drops straight to the pill; the workflow
// headers' Back returns to the card.
export function ProjectView({ request, onExit, onCollapse }: ProjectViewProps): ReactElement {
  const key = JSON.stringify(request);
  return (
    <Stack gap={0} h='100%' style={{ background: 'var(--paper)' }}>
      <TitleBar onCollapse={onCollapse} />
      {request.workflow === 'merge' ? (
        <MergeView key={key} request={request} onExit={onExit} />
      ) : (
        <CommitReview key={key} request={request} onExit={onExit} />
      )}
    </Stack>
  );
}
