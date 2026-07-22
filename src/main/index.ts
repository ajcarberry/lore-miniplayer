import { app, BrowserWindow, screen, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpcHandlers } from './ipc/handlers';
import {
  attachFocusDimming,
  registerMissionControlWindow,
  getMissionControlWindow,
  registerReviewWindow,
} from './ipc/window-handlers';
import { RepositoryService } from './services/repository';
import { initializeLoreSdk, shutdownLoreSdk } from './services/lore-sdk';
import { LoreRepositoryService } from './services/lore-repository';
import { WorkspaceService } from './services/workspace-service';
import { AgentObserverService } from './services/agent-observer';
import { AgentTranscriptService } from './services/agent-transcript';
import { WorkspaceModelService } from './services/workspace-model';
import { DiffService } from './services/diff-service';
import { MergeService } from './services/merge-service';
import { LockService } from './services/lock-service';
import { IPC_CHANNELS, WorkspaceModelSnapshotSchema } from '../shared/schemas';
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

// The agent observability hook listener; constructed in whenReady and stopped
// on quit. Module-scoped so the shutdown handler can reach it.
let agentObserverService: AgentObserverService | null = null;

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
  // The LoreRepositoryService resolves an attached checkout's true Lore
  // identity (url + stable id) so attach records the correct grouping key and
  // placeholder entries heal on load.
  repositoryService = new RepositoryService(log, loreRepositoryService);
  // Owns workspace provisioning/teardown; P7 later injects the observer hook
  // listener's port + token via workspaceService.setObserverConfig(...).
  const workspaceService = new WorkspaceService(log, repositoryService, loreRepositoryService);
  const diffService = new DiffService();
  // Owns the review window's merge workflow (design 2c): start/resolve/abort/
  // complete a branch→main merge, one in flight per repository.
  const mergeService = new MergeService(log, loreRepositoryService);
  const lockService = new LockService();

  // Agent observability (hook listener) + transcript enrichment feed the
  // workspace model (P9), which composes Lore signals and agent state into
  // per-repo Mission Control snapshots and owns the manual "mark active"
  // transition. Constructed before handler registration so markActive is
  // wired; the model's snapshot delivery to the renderer is wired by the
  // Mission Control window (P10).
  agentObserverService = new AgentObserverService(log);
  const transcriptService = new AgentTranscriptService(log);
  const workspaceModel = new WorkspaceModelService(log, {
    workspaces: workspaceService,
    observer: agentObserverService,
    transcript: transcriptService,
    lore: loreRepositoryService,
    diff: diffService,
    repository: repositoryService,
  });

  registerIpcHandlers(
    log,
    repositoryService,
    loreRepositoryService,
    workspaceService,
    workspaceModel,
    diffService,
    mergeService,
    lockService
  );

  // Then initialize the services
  await repositoryService.initialize();
  initializeLoreSdk();

  // Start the hook listener and hand its config to WorkspaceService so injected
  // hooks target the live listener. Session-state pushes are forwarded to the
  // renderer over the P2 push channel (payloads are Zod-validated in the
  // service before emit, mirroring the other push channels).
  agentObserverService.on('push', payload => {
    mainWindow?.webContents.send(IPC_CHANNELS.agent.observability, payload);
  });
  await agentObserverService.start();
  workspaceService.setObserverConfig(agentObserverService.getObserverConfig());

  // Mission Control window (P10, design 2a). Register its open/close + model
  // watch handlers, and forward the workspace model's snapshot rebuilds to the
  // open window over the P10 push channel — Zod-validated before it leaves the
  // main process, mirroring the other push channels. The window drives
  // watch()/unwatch() over its lifetime so the model only builds snapshots
  // while Mission Control is showing them.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const missionControlDevServerUrl = app.isPackaged
    ? undefined
    : process.env['ELECTRON_RENDERER_URL'];
  registerMissionControlWindow(log, {
    preloadPath: path.join(moduleDir, '../preload/preload.js'),
    rendererDir: path.join(moduleDir, '../renderer'),
    ...(missionControlDevServerUrl ? { devServerUrl: missionControlDevServerUrl } : {}),
    harden: win => hardenWebContents(win.webContents, log, missionControlDevServerUrl),
    model: workspaceModel,
  });
  // Review window (P11, design 2b/2c). Opened per workspace from Mission
  // Control's Review / Commit / Merge actions with its targets + workflow
  // preloaded; same chrome and security wiring as Mission Control.
  registerReviewWindow(log, {
    preloadPath: path.join(moduleDir, '../preload/preload.js'),
    rendererDir: path.join(moduleDir, '../renderer'),
    ...(missionControlDevServerUrl ? { devServerUrl: missionControlDevServerUrl } : {}),
    harden: win => hardenWebContents(win.webContents, log, missionControlDevServerUrl),
  });
  workspaceModel.on('snapshot', snapshot => {
    const win = getMissionControlWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    try {
      win.webContents.send(
        IPC_CHANNELS.workspaceModel.snapshot,
        WorkspaceModelSnapshotSchema.parse(snapshot)
      );
    } catch (error) {
      log.error('Failed to forward workspace snapshot to Mission Control', {
        error,
        operation: 'workspace:model:snapshot',
      });
    }
  });

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

app.on('will-quit', () => {
  // Stop the agent observability listener and free its sockets.
  if (agentObserverService) {
    void agentObserverService.stop();
    agentObserverService = null;
  }
  // Release the Lore SDK's native resources on exit
  try {
    shutdownLoreSdk();
  } catch (error) {
    log.error('Failed to shut down the Lore SDK', { error, operation: 'will-quit' });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
