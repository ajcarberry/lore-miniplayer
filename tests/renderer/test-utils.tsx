import type { ReactElement, ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';

export function renderWithMantine(
  ui: ReactNode,
  colorScheme?: 'light' | 'dark'
): ReturnType<typeof render> {
  return render(
    (
      <MantineProvider {...(colorScheme ? { forceColorScheme: colorScheme } : {})}>
        {ui}
      </MantineProvider>
    ) as ReactElement
  );
}
