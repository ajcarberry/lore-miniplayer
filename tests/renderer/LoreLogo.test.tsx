import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { LoreLogo } from '../../src/renderer/components/LoreLogo';

function renderLogo(
  colorScheme: 'light' | 'dark',
  props: Partial<Parameters<typeof LoreLogo>[0]> = {}
): ReturnType<typeof render> {
  return render(
    (
      <MantineProvider defaultColorScheme={colorScheme}>
        <LoreLogo variant='mark' height='20px' {...props} />
      </MantineProvider>
    ) as ReactElement
  );
}

describe('LoreLogo', () => {
  it('renders the white variant in dark mode and the black variant in light mode', () => {
    // When: rendering in dark mode
    const { unmount } = renderLogo('dark');

    // Then: the white asset is selected
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'white');
    unmount();

    // When: rendering in light mode
    renderLogo('light');

    // Then: the black asset is selected
    expect(screen.getByAltText('Lore')).toHaveAttribute('data-variant', 'black');
  });

  it('sizes by height with automatic width', () => {
    // When: rendering with a height (mark usage in the pill/header/title bar)
    renderLogo('light', { height: '28px' });

    // Then: the height is fixed and the width stays auto
    expect(screen.getByAltText('Lore')).toHaveStyle({ height: '28px', width: 'auto' });
  });

  it('sizes by width with automatic height for the logotype', () => {
    // When: rendering the logotype by width (connect page usage)
    renderLogo('light', { variant: 'type', width: '260px' });

    // Then: the width is fixed and the height stays auto
    expect(screen.getByAltText('Lore')).toHaveStyle({ width: '260px', height: 'auto' });
  });
});
