import { useEffect, useState } from 'react';
import type { ReviewOpenRequest } from '../../../shared/types';
import { ReviewOpenRequestSchema } from '../../../shared/schemas';
import { logError } from '../../utils/logging';

// Loads the review window's open request (design 2b/2c: workflow + compare
// preloaded by the opener). Subscribes to re-targets first, then pulls the
// current request on mount, so a context re-delivered during the pull is not
// missed. Every payload is
// Zod-validated before use, matching the other bridge channels.
export function useReviewContext(): ReviewOpenRequest | null {
  const [request, setRequest] = useState<ReviewOpenRequest | null>(null);

  useEffect(() => {
    let cancelled = false;

    const removeListener = window.electronAPI.review.onContext(payload => {
      const parsed = ReviewOpenRequestSchema.safeParse(payload);
      if (parsed.success) {
        setRequest(parsed.data);
      } else {
        logError('Received an invalid review context push', {
          error: parsed.error,
          operation: 'useReviewContext',
        });
      }
    });

    void window.electronAPI.review.requestContext().then(result => {
      if (cancelled) {
        return;
      }
      if (result.success) {
        setRequest(result.data);
      } else {
        logError('Failed to load review context', {
          error: result.error,
          operation: 'useReviewContext',
        });
      }
    });

    return (): void => {
      cancelled = true;
      removeListener();
    };
  }, []);

  return request;
}
