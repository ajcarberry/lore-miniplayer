import { renderHook, waitFor } from '@testing-library/react';
import { useRepositories } from '../../../src/renderer/hooks/useRepositories';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeRepository } from '../../mocks/repository-fixture';

describe('useRepositories', () => {
  let api: ReturnType<typeof installMockElectronAPI>;

  beforeEach(() => {
    api = installMockElectronAPI();
  });

  it('lists card-view-only repositories by default', async () => {
    // When: mounting with no includeProvisioned argument
    renderHook(() => useRepositories(true));

    // Then: the IPC call omits the flag, matching existing (pre-U2) behavior
    await waitFor(() => expect(api.repository.list).toHaveBeenCalledWith(undefined));
  });

  it('requests every origin when includeProvisioned is true', async () => {
    // When: mounting with includeProvisioned requested (the footer selector's
    // use, U2)
    renderHook(() => useRepositories(true, true));

    // Then: the flag is forwarded to the IPC call
    await waitFor(() => expect(api.repository.list).toHaveBeenCalledWith(true));
  });

  it('forwards includeProvisioned on refresh too', async () => {
    // Given: a mounted hook requesting every origin
    const repo = makeRepository();
    (api.repository.list as jest.Mock).mockResolvedValue({ success: true, data: [repo] });
    const { result } = renderHook(() => useRepositories(true, true));
    await waitFor(() => expect(result.current.repositories).toEqual([repo]));
    (api.repository.list as jest.Mock).mockClear();

    // When: refreshing
    await result.current.refresh();

    // Then: the same flag is used
    expect(api.repository.list).toHaveBeenCalledWith(true);
  });
});
