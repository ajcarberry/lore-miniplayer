import type { ReactElement } from 'react';
import { MantineProvider, Box } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { MiniPlayer } from './components/MiniPlayer';
import { theme } from './theme';
import { ThemeModeLoader } from './bootstrap';
import './styles/globals.css';
import './styles/morph.css';
import '@mantine/notifications/styles.css';

export function App(): ReactElement {
  return (
    <MantineProvider theme={theme} defaultColorScheme='auto'>
      <ThemeModeLoader />
      <Notifications position='top-right' />
      <Box
        style={{
          width: '100%',
          height: '100%',
          padding: 0,
          margin: 0,
          // Transparent so the collapsed pill floats in a card-sized, frameless
          // window; the parchment surface belongs to the pill/card, not the page.
          background: 'transparent',
        }}
      >
        <MiniPlayer />
      </Box>
    </MantineProvider>
  );
}
