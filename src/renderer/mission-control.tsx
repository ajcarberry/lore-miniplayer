import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { MissionControl } from './components/mission-control/MissionControl';
import { theme } from './theme';
import { useThemeMode } from './hooks/useThemeMode';
import './styles/globals.css';
import '@mantine/notifications/styles.css';

// Applies the persisted themeMode to Mantine's colorScheme, matching the main
// window (App.tsx); must render inside MantineProvider to reach its context.
function ThemeModeLoader(): null {
  useThemeMode();
  return null;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

createRoot(container).render(
  <MantineProvider theme={theme} defaultColorScheme='auto'>
    <ThemeModeLoader />
    <Notifications position='top-right' />
    <MissionControl />
  </MantineProvider>
);
