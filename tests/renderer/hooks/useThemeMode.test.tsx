import type { ReactElement, ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { useThemeMode } from '../../../src/renderer/hooks/useThemeMode';
import { installMockElectronAPI } from '../../mocks/electron-api';

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <MantineProvider>{children}</MantineProvider>;
}

describe('useThemeMode', () => {
  beforeEach(() => {
    installMockElectronAPI();
  });

  it('applies the persisted themeMode from config on mount', async () => {
    // Given: the persisted config has themeMode 'dark'
    (window.electronAPI.config.get as jest.Mock).mockResolvedValue({
      success: true,
      data: { themeMode: 'dark' },
    });

    // When: the hook mounts
    const { result } = renderHook(() => useThemeMode(), { wrapper });

    // Then: it reflects the persisted mode once loaded
    await waitFor(() => expect(result.current.themeMode).toBe('dark'));
    expect(result.current.isLoading).toBe(false);
  });

  it('defaults to auto when nothing is persisted', async () => {
    // When: the hook mounts against the default mock config (no themeMode)
    const { result } = renderHook(() => useThemeMode(), { wrapper });

    // Then: it settles on 'auto'
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.themeMode).toBe('auto');
  });

  it('persists and applies a new themeMode', async () => {
    // Given: the hook has finished loading
    const { result } = renderHook(() => useThemeMode(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // When: setting themeMode to 'light'
    await act(async () => {
      await result.current.setThemeMode('light');
    });

    // Then: the change is persisted through config:set
    expect(window.electronAPI.config.set).toHaveBeenCalledWith({ themeMode: 'light' });
    // And: the hook's local state reflects the new mode immediately
    expect(result.current.themeMode).toBe('light');
  });

  it('logs and rethrows when persisting the themeMode fails', async () => {
    // Given: config:set returns a failure result
    (window.electronAPI.config.set as jest.Mock).mockResolvedValue({
      success: false,
      error: 'disk full',
    });
    const { result } = renderHook(() => useThemeMode(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // When/Then: setting the mode rejects
    await expect(
      act(async () => {
        await result.current.setThemeMode('dark');
      })
    ).rejects.toThrow('disk full');
  });
});
