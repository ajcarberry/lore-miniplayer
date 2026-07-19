import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { ConnectPage } from '../../src/renderer/components/ConnectPage';

function renderConnectPage(colorScheme: 'light' | 'dark'): ReturnType<typeof render> {
  return render(
    (
      <MantineProvider defaultColorScheme={colorScheme}>
        <ConnectPage initialAddress='' onConnect={jest.fn()} />
      </MantineProvider>
    ) as ReactElement
  );
}

describe('ConnectPage', () => {
  it('renders the white logotype in dark mode and the black logotype in light mode', () => {
    // When: rendering in dark mode
    const { unmount } = renderConnectPage('dark');

    // Then: the white variant is selected
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'white');
    unmount();

    // When: rendering in light mode
    renderConnectPage('light');

    // Then: the black variant is selected so the logotype is visible on parchment
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'black');
  });
});
