import { useCallback, useEffect, useRef, useState } from 'react';
import { useMantineColorScheme } from '@mantine/core';
import type { ThemeMode } from '../../shared/types';
import { logError } from '../utils/logging';

export interface ThemeModeState {
  readonly themeMode: ThemeMode;
  readonly isLoading: boolean;
  readonly setThemeMode: (mode: ThemeMode) => Promise<void>;
}

// Loads the persisted theme mode from config on mount and applies it through
// Mantine's colorScheme mechanism; setThemeMode persists changes back to
// config and applies them immediately.
//
// Mantine's setColorScheme is a new function identity on every render, so it
// is tracked in a ref (kept current via its own effect) rather than a
// dependency, keeping the mount-only load effect from re-running on every
// render.
export function useThemeMode(): ThemeModeState {
  const { setColorScheme } = useMantineColorScheme();
  const setColorSchemeRef = useRef(setColorScheme);
  useEffect(() => {
    setColorSchemeRef.current = setColorScheme;
  });

  const [themeMode, setThemeModeState] = useState<ThemeMode>('auto');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      const result = await window.electronAPI.config.get();
      if (!result.success) {
        logError('Failed to load theme mode', { error: result.error, operation: 'useThemeMode' });
      } else if (!cancelled) {
        const mode = result.data.themeMode ?? 'auto';
        setThemeModeState(mode);
        setColorSchemeRef.current(mode);
      }
      if (!cancelled) {
        setIsLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const setThemeMode = useCallback(async (mode: ThemeMode): Promise<void> => {
    const result = await window.electronAPI.config.set({ themeMode: mode });
    if (!result.success) {
      logError('Failed to persist theme mode', {
        error: result.error,
        mode,
        operation: 'useThemeMode',
      });
      throw new Error(result.error);
    }
    setThemeModeState(mode);
    setColorSchemeRef.current(mode);
  }, []);

  return { themeMode, isLoading, setThemeMode };
}
