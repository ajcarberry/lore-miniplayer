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

  return (
    <Stack gap={0} h='100vh' style={{ background: 'var(--paper)' }}>
      <TitleBar />
      {request === null ? (
        <Center style={{ flex: 1 }}>
          <Loader />
        </Center>
      ) : request.workflow === 'merge' ? (
        // Keyed on the request so a re-target remounts with fresh merge state.
        <MergeView key={JSON.stringify(request)} request={request} />
      ) : (
        // Keyed on the request so a re-target (new compare/title) remounts with
        // fresh seeded state rather than resetting via an effect.
        <CommitReview key={JSON.stringify(request)} request={request} />
      )}
    </Stack>
  );
}
