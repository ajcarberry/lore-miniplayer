// Mock electron-log as a module with default export
const mockLog = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
  verbose: jest.fn(),
  debug: jest.fn(),
};

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: mockLog,
}));

import { EventEmitter } from 'node:events';
import log from 'electron-log/main.js';
import { hardenSession, hardenWebContents } from '../../src/main/security';
import type { Session, WebContents } from 'electron';

type WindowOpenHandler = (details: { url: string }) => { action: string };

interface FakeWebContents extends EventEmitter {
  setWindowOpenHandler: jest.Mock;
}

function fakeWebContents(): { contents: FakeWebContents; getOpenHandler: () => WindowOpenHandler } {
  const contents = new EventEmitter() as FakeWebContents;
  contents.setWindowOpenHandler = jest.fn();
  return {
    contents,
    getOpenHandler: () => contents.setWindowOpenHandler.mock.calls[0]![0] as WindowOpenHandler,
  };
}

function navigate(contents: FakeWebContents, url: string): { defaultPrevented: boolean } {
  const event = {
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  };
  contents.emit('will-navigate', event, url);
  return event;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('hardenWebContents', () => {
  it('should deny every window.open request', () => {
    // Given: a hardened webContents
    const { contents, getOpenHandler } = fakeWebContents();
    hardenWebContents(contents as unknown as WebContents, log);

    // When: the renderer tries to open a child window
    const result = getOpenHandler()({ url: 'https://evil.example.com' });

    // Then: the request is denied
    expect(result).toEqual({ action: 'deny' });
  });

  it('should block navigation to external http(s) URLs', () => {
    // Given: a hardened webContents
    const { contents } = fakeWebContents();
    hardenWebContents(contents as unknown as WebContents, log);

    // When: the frame tries to navigate to an external site
    const event = navigate(contents, 'https://evil.example.com/phish');

    // Then: the navigation is prevented and logged
    expect(event.defaultPrevented).toBe(true);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('should allow file: navigation (the packaged app bundle)', () => {
    // Given: a hardened webContents
    const { contents } = fakeWebContents();
    hardenWebContents(contents as unknown as WebContents, log);

    // When: the frame reloads the bundled index.html
    const event = navigate(contents, 'file:///app/renderer/index.html');

    // Then: the navigation proceeds
    expect(event.defaultPrevented).toBe(false);
  });

  it('should allow navigation within the dev-server origin when one is configured', () => {
    // Given: a hardened webContents in dev mode
    const { contents } = fakeWebContents();
    hardenWebContents(contents as unknown as WebContents, log, 'http://localhost:5173');

    // When: HMR triggers a full reload on the dev server
    const sameOrigin = navigate(contents, 'http://localhost:5173/index.html');
    const otherOrigin = navigate(contents, 'http://localhost:9999/');

    // Then: only the dev-server origin is allowed
    expect(sameOrigin.defaultPrevented).toBe(false);
    expect(otherOrigin.defaultPrevented).toBe(true);
  });

  it('should block redirects to external URLs', () => {
    // Given: a hardened webContents
    const { contents } = fakeWebContents();
    hardenWebContents(contents as unknown as WebContents, log);

    // When: a redirect targets an external site
    const event = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true;
      },
    };
    contents.emit('will-redirect', event, 'https://evil.example.com');

    // Then: the redirect is prevented
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('hardenSession', () => {
  it('should deny every permission request', () => {
    // Given: a session with a captured permission handler
    let handler:
      | ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | undefined;
    const fakeSession = {
      setPermissionRequestHandler: jest.fn((h: typeof handler) => {
        handler = h;
      }),
    };

    hardenSession(fakeSession as unknown as Session, log);

    // When: the renderer requests a permission
    const granted: boolean[] = [];
    handler!(null, 'media', result => granted.push(result));
    handler!(null, 'geolocation', result => granted.push(result));

    // Then: every request is denied
    expect(granted).toEqual([false, false]);
  });
});
