import { act, renderHook, waitFor } from '@testing-library/react';
import { useReviewContext } from '../../../src/renderer/components/review/useReviewContext';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeReviewRequest } from './fixtures';

// This suite's requests target a different workspace than the shared default.
const ACT2 = { workspacePath: '/wt/act2', branchName: 'agent/act2' };

interface ReviewApi {
  requestContext: jest.Mock;
  onContext: jest.Mock;
  removeListener: jest.Mock;
}

function installReviewApi(requestContextResult: unknown): ReviewApi {
  const api = installMockElectronAPI();
  const removeListener = jest.fn();
  const requestContext = jest.fn().mockResolvedValue(requestContextResult);
  const onContext = jest.fn().mockReturnValue(removeListener);
  Object.assign(api, { review: { open: jest.fn(), requestContext, onContext } });
  return { requestContext, onContext, removeListener };
}

describe('useReviewContext', () => {
  it('pulls the open request on mount', async () => {
    installReviewApi({ success: true, data: makeReviewRequest(ACT2) });

    const { result } = renderHook(() => useReviewContext());

    await waitFor(() => expect(result.current?.workspacePath).toBe('/wt/act2'));
  });

  it('updates when a re-target is pushed over onContext', async () => {
    const api = installReviewApi({ success: true, data: makeReviewRequest(ACT2) });
    const { result } = renderHook(() => useReviewContext());
    await waitFor(() => expect(result.current?.workflow).toBe('commit'));

    // Fire the registered push listener with a re-targeted (merge) request.
    const push = api.onContext.mock.calls[0]![0] as (payload: unknown) => void;
    act(() => push(makeReviewRequest({ ...ACT2, workflow: 'merge' })));

    expect(result.current?.workflow).toBe('merge');
  });

  it('ignores a malformed pushed payload', async () => {
    const api = installReviewApi({ success: true, data: makeReviewRequest(ACT2) });
    const { result } = renderHook(() => useReviewContext());
    await waitFor(() => expect(result.current).not.toBeNull());

    const push = api.onContext.mock.calls[0]![0] as (payload: unknown) => void;
    act(() => push({ nonsense: true }));

    // The valid pulled request is retained.
    expect(result.current?.workspacePath).toBe('/wt/act2');
  });

  it('leaves the request null and logs when the pull fails', async () => {
    installReviewApi({ success: false, error: 'no context' });

    const { result } = renderHook(() => useReviewContext());

    // Give the resolved rejection a tick; the request stays null.
    await waitFor(() => expect(result.current).toBeNull());
  });

  it('removes the push listener on unmount', () => {
    const api = installReviewApi({ success: true, data: makeReviewRequest(ACT2) });
    const { unmount } = renderHook(() => useReviewContext());
    unmount();
    expect(api.removeListener).toHaveBeenCalledTimes(1);
  });
});
