import { ipcMain, BrowserWindow, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  COLLAPSED_WINDOW_SIZE,
  EXPANDED_WINDOW_SIZE,
  computeCollapsedBounds,
  computeExpandedBounds,
} from '../../shared/window-position';
import type { Bounds, ExpandAnchor } from '../../shared/window-position';
import { IPC_CHANNELS, ReviewOpenRequestSchema } from '../../shared/schemas';
import type { Result, ReviewOpenRequest, WorkspaceModelSnapshot } from '../../shared/types';
import { failure, handleResult, success } from './result-helpers';
import {
  MissionControlOpenArgsSchema,
  WindowNoticeActiveSchema,
  WindowOpenTerminalArgsSchema,
  WorkspaceModelWatchArgsSchema,
  WorkspaceModelRefreshArgsSchema,
} from './validators';
import type { MainLogger } from './logger';

// Focus dimming with a notice override. The window dims to 70% opacity when it
// loses focus so the ambient pill recedes; while the renderer reports an
// active notice (sync needed), it stays fully opaque even unfocused — the
// pill's notice pulse must be visible precisely when the user works elsewhere.
const FOCUSED_OPACITY = 1.0;
const UNFOCUSED_OPACITY = 0.7;

let noticeActive = false;

function applyFocusOpacity(win: BrowserWindow): void {
  win.setOpacity(noticeActive || win.isFocused() ? FOCUSED_OPACITY : UNFOCUSED_OPACITY);
}

export function attachFocusDimming(win: BrowserWindow): void {
  win.on('blur', () => applyFocusOpacity(win));
  win.on('focus', () => applyFocusOpacity(win));
}

// Programmatic resize is ignored on a non-resizable window on some platforms;
// briefly allow it around the setBounds call, then restore the flag.
function setBoundsAllowingResize(win: BrowserWindow, bounds: Bounds): void {
  const wasResizable = win.isResizable();
  if (!wasResizable) {
    win.setResizable(true);
  }
  win.setBounds(bounds);
  if (!wasResizable) {
    win.setResizable(false);
  }
}

function openTerminalDarwin(workingDirectory: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // `open -a Terminal <dir>` receives the path as a plain argv element — no
    // shell or AppleScript string is ever built from it, so metacharacters in
    // the path are inert.
    const open = spawn('open', ['-a', 'Terminal', workingDirectory]);
    open.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`open exited with code ${code}`));
      }
    });
    open.on('error', reject);
  });
}

function openTerminalWindows(workingDirectory: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Use 'start' to open a new PowerShell window in the working directory
    const cmd = spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        'powershell.exe',
        '-NoExit',
        '-Command',
        `Set-Location -LiteralPath '${workingDirectory.replace(/'/g, "''")}'`,
      ],
      { detached: true, stdio: 'ignore', shell: false, cwd: workingDirectory }
    );
    cmd.unref();
    cmd.on('error', reject);
    // Resolve immediately for Windows as the process is detached
    resolve();
  });
}

function openTerminalLinux(workingDirectory: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Try gnome-terminal first, then fall back to xterm. Both receive the
    // path as argv/cwd only — no shell command string is built from it.
    let fellBack = false;
    const gnomeTerminal = spawn('gnome-terminal', [`--working-directory=${workingDirectory}`], {
      detached: true,
      stdio: 'ignore',
    });
    gnomeTerminal.unref();
    gnomeTerminal.on('error', () => {
      fellBack = true;
      // xterm with no command starts the user's shell in `cwd`.
      const xterm = spawn('xterm', [], {
        cwd: workingDirectory,
        detached: true,
        stdio: 'ignore',
      });
      xterm.unref();
      xterm.on('spawn', () => resolve());
      xterm.on('error', reject);
    });
    gnomeTerminal.on('close', () => {
      if (!fellBack) {
        resolve();
      }
    });
  });
}

// Exported with an explicit platform (like validateWindowsPath) so every
// platform branch is asserted on every host.
export async function openTerminal(
  workingDirectory: string,
  platform: typeof process.platform = os.platform()
): Promise<void> {
  // Validate that the path exists and is a directory
  const fs = await import('node:fs/promises');
  try {
    const stat = await fs.stat(workingDirectory);
    if (!stat.isDirectory()) {
      throw new Error('Path is not a directory');
    }
  } catch {
    throw new Error('Directory does not exist');
  }

  switch (platform) {
    case 'darwin':
      return openTerminalDarwin(workingDirectory);
    case 'win32':
      return openTerminalWindows(workingDirectory);
    case 'linux':
      return openTerminalLinux(workingDirectory);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export function registerWindowHandlers(log: MainLogger): void {
  ipcMain.on('window:minimize', event => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window:close', event => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // Move the window during a manual pill drag. Fired on every pointermove, so
  // it is a one-way `send` (no per-move round-trip). Coordinates are validated;
  // an invalid payload is logged and ignored rather than crashing the drag.
  ipcMain.on('window:move', (event, x: unknown, y: unknown) => {
    // Live drag coordinates may be fractional (Retina pointer math) — round
    // rather than reject; only non-finite input is dropped.
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
      log.error('Invalid window move coordinates', { x, y, operation: 'window:move' });
      return;
    }
    BrowserWindow.fromWebContents(event.sender)?.setPosition(Math.round(x), Math.round(y));
  });

  // Opacity is re-applied immediately so an active notice un-dims an
  // already-blurred window and a cleared one resumes normal dimming without
  // a focus event.
  ipcMain.on('window:setNoticeActive', (event, rawActive: unknown) => {
    const parsed = WindowNoticeActiveSchema.safeParse(rawActive);
    if (!parsed.success) {
      log.error('Invalid setNoticeActive payload', {
        rawActive,
        operation: 'window:setNoticeActive',
      });
      return;
    }
    noticeActive = parsed.data;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      applyFocusOpacity(win);
    }
  });

  // The last expansion anchor, so a subsequent collapse shrinks back to the
  // same corner the expansion grew from (single ambient window).
  let lastAnchor: ExpandAnchor = 'bottom';

  // Morph between the collapsed (pill) and expanded (card) window footprints in
  // the MAIN process — the renderer never sends raw bounds. Expanding computes
  // the anchor direction from the display work area and returns it so the
  // renderer's CSS unfold matches the window's growth direction.
  ipcMain.handle('window:setExpanded', (event, rawExpanded: unknown): { anchor: ExpandAnchor } => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (typeof rawExpanded !== 'boolean' || !win) {
      if (typeof rawExpanded !== 'boolean') {
        log.error('Invalid setExpanded payload', { rawExpanded, operation: 'window:setExpanded' });
      }
      return { anchor: lastAnchor };
    }
    const current = win.getBounds();
    if (rawExpanded) {
      const workArea = screen.getDisplayMatching(current).workArea;
      const { bounds, anchor } = computeExpandedBounds(current, EXPANDED_WINDOW_SIZE, workArea);
      lastAnchor = anchor;
      setBoundsAllowingResize(win, bounds);
      return { anchor };
    }
    setBoundsAllowingResize(
      win,
      computeCollapsedBounds(current, COLLAPSED_WINDOW_SIZE, lastAnchor)
    );
    return { anchor: lastAnchor };
  });

  handleResult(log, 'window:open-terminal', WindowOpenTerminalArgsSchema, workingDirectory =>
    openTerminal(workingDirectory)
  );
}

// ---------------------------------------------------------------------------
// Mission Control window (P10, design 2a): a secondary, single-instance window
// scoped to the selected repository. It is NOT the always-on-top ambient pill —
// it is a normal, movable window with the app's own frameless TitleBar chrome.
// ---------------------------------------------------------------------------

// The subset of the workspace model this window drives: it warms the snapshot
// cache (watch/snapshot) so markActive can resolve a workspace, releases the
// model's listeners when the window closes (CLAUDE.md cleanup rule), and lets
// the header's manual refresh control trigger an immediate rebuild.
export interface MissionControlModel {
  watch(repositoryId: string): void;
  unwatch(): void;
  snapshot(repositoryId: string): Promise<WorkspaceModelSnapshot>;
  refreshNow(repositoryId: string): Promise<void>;
}

export interface MissionControlWindowDeps {
  readonly preloadPath: string;
  readonly rendererDir: string;
  readonly devServerUrl?: string;
  // Security wiring stays with the caller (index.ts owns the logger + dev URL);
  // applied to every window this factory creates, per security.ts.
  readonly harden: (win: BrowserWindow) => void;
  readonly model: MissionControlModel;
}

// Mission Control content is 680px (design 2a); the window adds chrome padding.
const MISSION_CONTROL_SIZE = { width: 720, height: 780 } as const;

// Single ambient Mission Control window; module-scoped so the snapshot
// forwarder in index.ts can reach it and so re-opening focuses rather than
// duplicating (packet: one instance max).
let missionControlWindow: BrowserWindow | null = null;

export function getMissionControlWindow(): BrowserWindow | null {
  return missionControlWindow;
}

export function registerMissionControlWindow(
  log: MainLogger,
  deps: MissionControlWindowDeps
): void {
  ipcMain.on(IPC_CHANNELS.missionControl.open, (_event, rawRepositoryId: unknown): void => {
    const parsed = MissionControlOpenArgsSchema.safeParse([rawRepositoryId]);
    if (!parsed.success) {
      log.error('Invalid missionControl:open payload', {
        rawRepositoryId,
        operation: IPC_CHANNELS.missionControl.open,
      });
      return;
    }
    const [repositoryId] = parsed.data;

    // Already open: re-target the model at the requested repo and focus.
    if (missionControlWindow && !missionControlWindow.isDestroyed()) {
      if (repositoryId !== undefined) {
        deps.model.watch(repositoryId);
      }
      missionControlWindow.focus();
      return;
    }

    const win = new BrowserWindow({
      width: MISSION_CONTROL_SIZE.width,
      height: MISSION_CONTROL_SIZE.height,
      frame: false,
      title: 'Lore MiniPlayer — Mission Control',
      backgroundColor: '#f7f2e7',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: deps.preloadPath,
      },
    });
    deps.harden(win);

    if (deps.devServerUrl !== undefined) {
      void win.loadURL(`${deps.devServerUrl}/mission-control.html`);
    } else {
      void win.loadFile(path.join(deps.rendererDir, 'mission-control.html'));
    }

    win.on('closed', () => {
      missionControlWindow = null;
      // The model was watching this repo only for the window; release it.
      deps.model.unwatch();
    });

    if (repositoryId !== undefined) {
      deps.model.watch(repositoryId);
    }
    missionControlWindow = win;
  });

  // Close from the opener (the ambient window's footer icon toggles it). The
  // window's own TitleBar close uses the shared window:close handler instead.
  ipcMain.on(IPC_CHANNELS.missionControl.close, () => {
    if (missionControlWindow && !missionControlWindow.isDestroyed()) {
      missionControlWindow.close();
    }
  });

  // Point the workspace model at a repository and return its current snapshot.
  // watch() warms the cache markActive depends on and starts the snapshot push
  // stream; the returned snapshot seeds the renderer without a push race.
  handleResult(
    log,
    IPC_CHANNELS.workspaceModel.watch,
    WorkspaceModelWatchArgsSchema,
    repositoryId => {
      deps.model.watch(repositoryId);
      return deps.model.snapshot(repositoryId);
    }
  );

  // Manual refresh (the header's refresh control): trigger an immediate
  // rebuild for the watched repository, reusing the same refresh path the
  // automatic triggers use. The rebuilt snapshot arrives via the push
  // channel, not this invoke's own response.
  handleResult(
    log,
    IPC_CHANNELS.workspaceModel.refresh,
    WorkspaceModelRefreshArgsSchema,
    repositoryId => deps.model.refreshNow(repositoryId)
  );
}

// ---------------------------------------------------------------------------
// Review window (P11, design 2b/2c): a secondary, per-workspace window opened
// from Mission Control's Review / Commit / Merge actions with its targets and
// workflow preloaded. Mirrors the Mission Control window's chrome and security
// wiring; one instance per workspace checkout (keyed by its path).
// ---------------------------------------------------------------------------

export interface ReviewWindowDeps {
  readonly preloadPath: string;
  readonly rendererDir: string;
  readonly devServerUrl?: string;
  // Security wiring stays with the caller (index.ts owns the logger + dev URL),
  // applied to every window this factory creates, per security.ts.
  readonly harden: (win: BrowserWindow) => void;
}

// Design 2b content is 1180px wide; the window adds chrome padding.
const REVIEW_WINDOW_SIZE = { width: 1220, height: 840 } as const;

// One review window per workspace checkout; module-scoped so re-opening the
// same workspace focuses/re-targets rather than duplicating, and so the open
// request can be handed back to the window on mount (requestContext).
const reviewWindows = new Map<string, BrowserWindow>();
const reviewRequests = new WeakMap<BrowserWindow, ReviewOpenRequest>();

export function getReviewWindow(workspacePath: string): BrowserWindow | null {
  const win = reviewWindows.get(workspacePath);
  return win && !win.isDestroyed() ? win : null;
}

export function registerReviewWindow(log: MainLogger, deps: ReviewWindowDeps): void {
  ipcMain.on(IPC_CHANNELS.review.open, (_event, rawRequest: unknown): void => {
    const parsed = ReviewOpenRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      log.error('Invalid review:open payload', {
        error: parsed.error,
        rawRequest,
        operation: IPC_CHANNELS.review.open,
      });
      return;
    }
    const request = parsed.data;

    // Already open for this workspace: re-target the window's workflow/compare
    // and focus, rather than opening a duplicate (packet: one per workspace).
    const existing = reviewWindows.get(request.workspacePath);
    if (existing && !existing.isDestroyed()) {
      reviewRequests.set(existing, request);
      existing.webContents.send(IPC_CHANNELS.review.context, request);
      existing.focus();
      return;
    }

    const win = new BrowserWindow({
      width: REVIEW_WINDOW_SIZE.width,
      height: REVIEW_WINDOW_SIZE.height,
      frame: false,
      title: `Review — ${request.title ?? request.branchName}`,
      backgroundColor: '#f7f2e7',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: deps.preloadPath,
      },
    });
    deps.harden(win);
    reviewRequests.set(win, request);
    reviewWindows.set(request.workspacePath, win);

    if (deps.devServerUrl !== undefined) {
      void win.loadURL(`${deps.devServerUrl}/review.html`);
    } else {
      void win.loadFile(path.join(deps.rendererDir, 'review.html'));
    }

    win.on('closed', () => {
      reviewWindows.delete(request.workspacePath);
    });
  });

  // The review renderer pulls its open request on mount. The sender's
  // webContents identifies which window (and thus which stored request) is
  // asking, so no workspace id crosses the query string.
  ipcMain.handle(
    IPC_CHANNELS.review.requestContext,
    (event: IpcMainInvokeEvent): Result<ReviewOpenRequest> => {
      for (const win of reviewWindows.values()) {
        if (!win.isDestroyed() && win.webContents === event.sender) {
          const request = reviewRequests.get(win);
          if (request) {
            return success(request);
          }
        }
      }
      return failure('No review context for this window');
    }
  );
}
