import type { ReactElement, ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';

export function renderWithMantine(ui: ReactNode): ReturnType<typeof render> {
  return render((<MantineProvider>{ui}</MantineProvider>) as ReactElement);
}
