import { useEffect, useState } from 'react';
import type { ReviewOpenRequest } from '../../../shared/types';
import { ReviewOpenRequestSchema } from '../../../shared/schemas';
import { subscribeThenPull } from '../../utils/ipc';

// Loads the review window's open request (design 2b/2c: workflow + compare
// preloaded by Mission Control). Subscribes to re-targets first, then pulls
// the current request on mount (the shared subscribe-then-pull skeleton, same
// as the Mission Control snapshot hook) so a context re-delivered during the
// pull is not missed. Every payload is Zod-validated before use, matching the
// other bridge channels.
export function useReviewContext(): ReviewOpenRequest | null {
  const [request, setRequest] = useState<ReviewOpenRequest | null>(null);

  useEffect(
    () =>
      subscribeThenPull({
        subscribe: listener => window.electronAPI.review.onContext(listener),
        parsePush: payload => {
          const parsed = ReviewOpenRequestSchema.safeParse(payload);
          return parsed.success ? parsed.data : null;
        },
        onPush: setRequest,
        pull: () => window.electronAPI.review.requestContext(),
        onPull: setRequest,
        pullErrorMessage: 'Failed to load review context',
        pullErrorContext: { operation: 'useReviewContext' },
      }),
    []
  );

  return request;
}
