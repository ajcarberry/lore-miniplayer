import type { ReactElement } from 'react';
import { Center, Loader, Stack } from '@mantine/core';
import { TitleBar } from '../TitleBar';
import { useReviewContext } from './useReviewContext';
import { CommitReview } from './CommitReview';
import { MergeView } from './MergeView';

// The review window root (design 2b/2c). Loads its preloaded open request, then
// routes by workflow: commit (P11) and merge (P14, design 2c) each own a view.
// The frameless TitleBar chrome is shared across both, matching Mission Control.
export function ReviewWindow(): ReactElement {
  const request = useReviewContext();
  // Keyed on the request so a re-target remounts the view with fresh seeded
  // state rather than resetting via an effect.
  const key = request === null ? undefined : JSON.stringify(request);

  return (
    <Stack gap={0} h='100vh' style={{ background: 'var(--paper)' }}>
      <TitleBar />
      {request === null ? (
        <Center style={{ flex: 1 }}>
          <Loader />
        </Center>
      ) : request.workflow === 'merge' ? (
        <MergeView key={key} request={request} />
      ) : (
        <CommitReview key={key} request={request} />
      )}
    </Stack>
  );
}
