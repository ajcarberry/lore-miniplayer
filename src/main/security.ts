import type { Session, WebContents } from 'electron';
import type { MainLogger } from './ipc/logger';

// The app is a single local-only window: the renderer never legitimately
// opens child windows, navigates away from the bundled app, or needs any
// browser permission. Everything here is deny-by-default.

function isAllowedNavigation(url: string, devServerUrl: string | undefined): boolean {
  // The packaged app runs from file:; in dev the only legitimate frame
  // navigation is an HMR full reload within the dev-server origin.
  if (url.startsWith('file:')) {
    return true;
  }
  if (devServerUrl === undefined) {
    return false;
  }
  try {
    return new URL(url).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

export function hardenWebContents(
  contents: WebContents,
  log: MainLogger,
  devServerUrl?: string
): void {
  contents.setWindowOpenHandler(({ url }) => {
    log.error('Blocked window.open from renderer', { url, operation: 'window-open' });
    return { action: 'deny' };
  });

  const guardNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAllowedNavigation(url, devServerUrl)) {
      log.error('Blocked navigation from renderer', { url, operation: 'will-navigate' });
      event.preventDefault();
    }
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
}

export function hardenSession(appSession: Session, log: MainLogger): void {
  appSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    log.error('Denied permission request from renderer', {
      permission,
      operation: 'permission-request',
    });
    callback(false);
  });
}
