import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';

// A promise whose resolution the test controls — used to hold a mocked IPC
// response pending (e.g. to prove stale responses are discarded).
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

// Renders a component inside MantineProvider; the wrapper is also applied on
// every `rerender`, so tests pass bare elements throughout.
export function renderWithMantine(ui: ReactElement): ReturnType<typeof render> {
  return render(ui, { wrapper: MantineProvider });
}
