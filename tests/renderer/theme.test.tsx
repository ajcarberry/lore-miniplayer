import { Button, MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { theme } from '../../src/renderer/theme';

// These tests render with the real app theme (not the bare provider from
// test-utils) because the behavior under test lives in the theme itself.
function renderWithAppTheme(ui: ReactElement): void {
  render(<MantineProvider theme={theme}>{ui}</MantineProvider>);
}

describe('theme Button overrides', () => {
  it('should give the default (filled, uncolored) Button the accent fill', () => {
    // Given: a Button with no variant and no color
    renderWithAppTheme(<Button>Commit</Button>);

    // Then: the parchment accent fill applies
    const button = screen.getByRole('button', { name: 'Commit' });
    expect(button.style.backgroundColor).toBe('var(--acc)');
    expect(button.style.color).toBe('var(--paper)');
  });

  it('should not repaint a destructive (color=red) Button with the accent fill', () => {
    // Given: a destructive action button
    renderWithAppTheme(<Button color='red'>Reset Repository</Button>);

    // Then: the red danger signal survives — the accent fill is not forced on
    const button = screen.getByRole('button', { name: 'Reset Repository' });
    expect(button.style.backgroundColor).not.toBe('var(--acc)');
    expect(button.style.color).not.toBe('var(--paper)');
  });

  it('should not repaint a subtle Cancel Button with the accent fill', () => {
    // Given: a subtle secondary action
    renderWithAppTheme(<Button variant='subtle'>Cancel</Button>);

    // Then: it stays visually subordinate to the primary action
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.style.backgroundColor).not.toBe('var(--acc)');
  });

  it('should not repaint a light-variant Button with the accent fill', () => {
    // Given: a light secondary action
    renderWithAppTheme(<Button variant='light'>Keep</Button>);

    // Then: the light variant's own colors survive
    const button = screen.getByRole('button', { name: 'Keep' });
    expect(button.style.backgroundColor).not.toBe('var(--acc)');
  });
});
