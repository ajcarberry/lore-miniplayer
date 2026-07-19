import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// The renderer's logging util lazily imports electron-log, which every
// renderer suite previously had to neutralize with an identical per-file
// jest.mock block. Registering the mock here (before any test module loads)
// gives all suites the same inert logger.
jest.mock('electron-log/renderer.js', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn() },
}));

// Mantine portals (Popover/Menu dropdowns) mount via rAF-driven transitions;
// under full-suite parallel load these can exceed testing-library's 1s default
// findBy*/waitFor timeout and flake. Raise the poll ceiling — waits stay
// condition-based and return as soon as the condition holds.
configure({ asyncUtilTimeout: 4000 });

// jsdom does not implement these browser APIs that Mantine relies on
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });

  class ResizeObserverMock {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  }
  window.ResizeObserver = window.ResizeObserver ?? ResizeObserverMock;

  window.HTMLElement.prototype.scrollIntoView =
    window.HTMLElement.prototype.scrollIntoView ?? jest.fn();

  // jsdom does not implement pointer capture, which the pill drag machine uses.
  window.HTMLElement.prototype.setPointerCapture =
    window.HTMLElement.prototype.setPointerCapture ?? jest.fn();
  window.HTMLElement.prototype.releasePointerCapture =
    window.HTMLElement.prototype.releasePointerCapture ?? jest.fn();
}
