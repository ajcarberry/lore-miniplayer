import { renderHook, waitFor } from '@testing-library/react';
import { useResolvedUserName } from '../../../src/renderer/hooks/useResolvedUserName';
import { installMockElectronAPI } from '../../mocks/electron-api';

function install(resolveUserName: jest.Mock): void {
  const api = installMockElectronAPI();
  Object.assign(api, { identity: { resolveUserName } });
}

describe('useResolvedUserName', () => {
  it('returns null and skips the fetch when repositoryPath or userId is null', () => {
    // Given: no toast currently queued (both args null)
    const resolveUserName = jest.fn();
    install(resolveUserName);

    // When: the hook mounts
    const { result } = renderHook(() => useResolvedUserName(null, null));

    // Then: nothing is fetched and the raw-id fallback (null) is returned
    expect(result.current).toBeNull();
    expect(resolveUserName).not.toHaveBeenCalled();
  });

  it('falls back to null (raw userId at the call site) while the resolution is in flight', () => {
    // Given: an invoke that never settles within this test
    const resolveUserName = jest.fn().mockReturnValue(new Promise(() => {}));
    install(resolveUserName);

    // When: the hook mounts with a repositoryPath + userId
    const { result } = renderHook(() => useResolvedUserName('/repo', 'in-flight-user'));

    // Then: still null until it resolves
    expect(result.current).toBeNull();
    expect(resolveUserName).toHaveBeenCalledWith({
      repositoryPath: '/repo',
      userId: 'in-flight-user',
    });
  });

  it('resolves to the display name once the invoke succeeds', async () => {
    // Given: a successful resolution
    const resolveUserName = jest
      .fn()
      .mockResolvedValue({ success: true, data: { name: 'Mara Voss' } });
    install(resolveUserName);

    // When: the hook mounts
    const { result } = renderHook(() => useResolvedUserName('/repo', 'resolves-user'));

    // Then: the resolved name is returned
    await waitFor(() => expect(result.current).toBe('Mara Voss'));
  });

  it('falls back to null on a failed resolution', async () => {
    // Given: the invoke fails (e.g. no auth endpoint offline)
    const resolveUserName = jest
      .fn()
      .mockResolvedValue({ success: false, error: 'No auth endpoint available' });
    install(resolveUserName);

    // When: the hook mounts
    const { result } = renderHook(() => useResolvedUserName('/repo', 'failed-user'));

    // Then: it settles on null rather than fabricating a name
    await waitFor(() => expect(resolveUserName).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('caches a resolved name so a second mount for the same pair skips the invoke', async () => {
    // Given: a prior successful resolution for this repositoryPath/userId pair
    const resolveUserName = jest
      .fn()
      .mockResolvedValue({ success: true, data: { name: 'Mara Voss' } });
    install(resolveUserName);
    const first = renderHook(() => useResolvedUserName('/repo', 'cached-user'));
    await waitFor(() => expect(first.result.current).toBe('Mara Voss'));
    first.unmount();
    resolveUserName.mockClear();

    // When: a second hook mounts for the same pair
    const { result } = renderHook(() => useResolvedUserName('/repo', 'cached-user'));

    // Then: the cached name is returned synchronously, without a new invoke
    expect(result.current).toBe('Mara Voss');
    expect(resolveUserName).not.toHaveBeenCalled();
  });
});
