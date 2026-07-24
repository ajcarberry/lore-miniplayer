import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { theme } from './theme';
import { useThemeMode } from './hooks/useThemeMode';
import './styles/globals.css';
import '@mantine/notifications/styles.css';

// Applies the persisted themeMode (config:get) to Mantine's colorScheme once
// the window mounts; must render inside MantineProvider to reach its context.
// Shared by the main window (App.tsx) and the secondary-window bootstraps.
export function ThemeModeLoader(): null {
  useThemeMode();
  return null;
}

// Shared React bootstrap for the secondary windows (Mission Control, review):
// mounts the given surface under the app theme, the theme-mode loader, and the
// notifications outlet.
export function bootstrapWindow(surface: ReactElement): void {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Root element not found');
  }

  createRoot(container).render(
    <MantineProvider theme={theme} defaultColorScheme='auto'>
      <ThemeModeLoader />
      <Notifications position='top-right' />
      {surface}
    </MantineProvider>
  );
}
