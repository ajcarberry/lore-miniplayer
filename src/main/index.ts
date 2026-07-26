import { app, BrowserWindow, screen, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpcHandlers } from './ipc/handlers';
import { attachFocusDimming } from './ipc/window-handlers';
import { RepositoryService } from './services/repository';
import { initializeLoreSdk } from './services/lore-sdk';
import { LoreRepositoryService } from './services/lore-repository';
import { DiffService } from './services/diff-service';
import { MergeService } from './services/merge-service';
import { loadWindowPosition, saveWindowPosition } from './ipc/config-handlers';
import { hardenSession, hardenWebContents } from './security';
import { COLLAPSED_WINDOW_SIZE, resolveRestorePosition } from '../shared/window-position';
import type { WindowPosition } from '../shared/window-position';
import type { MainLogger } from './ipc/logger';

// Test isolation: when set (by the e2e harness), redirect Electron's userData
// directory before anything (logging, config, IPC) reads from it, so tests
// never touch the real user's profile. Must run before app.whenReady() and
// before any app.getPath('userData') call; inert when unset.
const testUserDataOverride = process.env['LORE_MINIPLAYER_USER_DATA'];
if (testUserDataOverride) {
  app.setPath('userData', testUserDataOverride);
}

// E2e harness flag: never show the window and (on macOS) no dock icon, so
// test runs don't flash UI or steal focus. Dock hidden before
// app.whenReady() to avoid the launch bounce.
const isHiddenTestMode = process.env['LORE_MINIPLAYER_E2E_HIDDEN'] === '1';
if (isHiddenTestMode && process.platform === 'darwin') {
  app.dock?.hide();
}

// Log instance will be initialized with dynamic import
let log: MainLogger;

// Configure logging after dynamic import
async function initializeLogging(): Promise<void> {
  const electronLog = await import('electron-log/main.js');
  log = electronLog.default;

  log.initialize();
  log.transports.file.resolvePathFn = (): string =>
    path.join(app.getPath('userData'), 'logs', 'main.log');
  log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
}

// The Lore SDK resolves its native library from the platform-specific
// @lore-vcs/sdk-<platform> package and rewrites app.asar paths to
// app.asar.unpacked itself; no manual library path setup is required.

// Global reference to main window
let mainWindow: BrowserWindow | null = null;

// Constructed after logging is initialized (whenReady) so the logger can be
// injected like every other service/handler group.
let repositoryService: RepositoryService;
const loreRepositoryService = new LoreRepositoryService();

// Forward server push notifications to the renderer. The subscription
// itself is renderer-driven via lore:notifications:subscribe/unsubscribe.
loreRepositoryService.on('notification', notification => {
  mainWindow?.webContents.send('lore:notification', notification);
});

// Forward clone progress streamed by the SDK during lore:repository:clone.
loreRepositoryService.on('cloneProgress', progress => {
  mainWindow?.webContents.send('lore:repository:clone-progress', progress);
});

const POSITION_SAVE_DEBOUNCE_MS = 500;

// Resolve the window's launch position from the saved config. The saved value
// is the pill's canonical top-left (see attachPositionPersistence). The player
// may be dragged anywhere on screen, so it is honored exactly as long as the
// pill is still reachable on some display; only a fully-off-screen pill is
// rescued. Returns null when nothing has been saved (Electron then centers).
async function resolveInitialPosition(): Promise<WindowPosition | null> {
  const saved = await loadWindowPosition(log);
  if (!saved) {
    return null;
  }
  const displays = screen
    .getAllDisplays()
    .map(display => ({ bounds: display.bounds, workArea: display.workArea }));
  return resolveRestorePosition(saved, COLLAPSED_WINDOW_SIZE, displays);
}

// Persist the pill's canonical position after the window settles, debounced so
// a drag doesn't hammer the config file. The window resizes between the pill
// and card footprints keeping the bottom-right corner fixed, so we save the
// equivalent collapsed (pill) top-left — bottom-right minus the collapsed size
// — which is invariant across expand/collapse and restores the pill correctly.
function attachPositionPersistence(window: BrowserWindow): void {
  let timer: ReturnType<typeof global.setTimeout> | null = null;
  const persist = (): void => {
    if (timer !== null) {
      global.clearTimeout(timer);
    }
    timer = global.setTimeout(() => {
      timer = null;
      if (!mainWindow) {
        return;
      }
      const bounds = mainWindow.getBounds();
      const pillTopLeft = {
        x: bounds.x + bounds.width - COLLAPSED_WINDOW_SIZE.width,
        y: bounds.y + bounds.height - COLLAPSED_WINDOW_SIZE.height,
      };
      void saveWindowPosition(pillTopLeft, log);
    }, POSITION_SAVE_DEBOUNCE_MS);
  };
  // 'moved' is macOS-only (fires once at drag end); 'move' fires on all
  // platforms during the drag. Debouncing coalesces both to one write.
  window.on('move', persist);
  window.on('moved', persist);
}

async function createWindow(): Promise<void> {
  const isDev = !app.isPackaged;

  // Get directory path for ES modules
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // electron-vite compiles preload.ts to preload.js in the preload directory
  const preloadPath = path.join(__dirname, '../preload/preload.js');

  const position = await resolveInitialPosition();

  mainWindow = new BrowserWindow({
    // Launch at the collapsed (pill) footprint; the renderer grows the window
    // to the card on mount when disconnected or when the pill is clicked.
    width: COLLAPSED_WINDOW_SIZE.width,
    height: COLLAPSED_WINDOW_SIZE.height,
    ...(position ? { x: position.x, y: position.y } : {}),
    ...(isHiddenTestMode ? { show: false } : {}),
    resizable: false,
    maximizable: false,
    frame: false,
    alwaysOnTop: true,
    // Transparent, shadowless frame: the ambient pill/card draws its own
    // parchment surface and shadow; the surrounding window area is empty.
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Lore MiniPlayer',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: preloadPath,
      // Never-shown windows otherwise get Chromium timer/rAF throttling.
      ...(isHiddenTestMode ? { backgroundThrottling: false } : {}),
    },
  });

  const devServerUrl = isDev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
  hardenWebContents(mainWindow.webContents, log, devServerUrl);

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  attachFocusDimming(mainWindow);

  attachPositionPersistence(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Initialize logging first
  await initializeLogging();

  // Register IPC handlers before any renderer loads
  repositoryService = new RepositoryService(log);
  const diffService = new DiffService(loreRepositoryService);
  // Owns the Project View's merge workflow: start/resolve/abort/complete a
  // branch→target merge, one in flight per repository.
  const mergeService = new MergeService(log, loreRepositoryService);
  registerIpcHandlers(log, repositoryService, loreRepositoryService, diffService, mergeService);

  // Then initialize the services
  await repositoryService.initialize();
  initializeLoreSdk();

  // Deny-by-default browser permission requests
  hardenSession(session.defaultSession, log);

  // Configure Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isDev = !app.isPackaged;
    const cspHeader = isDev
      ? [
          "default-src 'self'",
          "script-src 'self' 'unsafe-eval' 'unsafe-inline'", // unsafe-eval and unsafe-inline needed for dev mode
          "style-src 'self' 'unsafe-inline'", // unsafe-inline needed for React/Mantine
          "img-src 'self' data:",
          "connect-src 'self' http://localhost:* ws://localhost:*", // Allow dev server connections
          "font-src 'self' data:",
          "worker-src 'self' blob:", // Allow Vite HMR workers in dev mode
        ].join('; ')
      : [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'", // Still needed for React/Mantine in production
          "img-src 'self' data:",
          "connect-src 'self'",
          "font-src 'self' data:",
        ].join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspHeader],
      },
    });
  });

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

// Quit does not call lore.shutdown(): it is a synchronous FFI call that blocks
// the main thread for a fixed ~10s native drain and cannot be time-bounded from
// JS. The SDK flushes its file logs incrementally, so the OS reclaiming native
// threads, sockets, and memory on process exit is both sufficient and safe.

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
