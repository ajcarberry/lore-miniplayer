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
import type { Result, ReviewOpenRequest } from '../../shared/types';
import { failure, handleResult, success } from './result-helpers';
import { WindowNoticeActiveSchema, WindowOpenTerminalArgsSchema } from './validators';
import { abortActiveMerge } from '../services/merge-registry';
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
// Secondary windows (Review): normal, movable windows with the app's own
// frameless TitleBar chrome — NOT the always-on-top ambient pill. One shared
// chrome + security recipe, parameterized by size, title, and entry html.
// ---------------------------------------------------------------------------

export interface SecondaryWindowDeps {
  readonly preloadPath: string;
  readonly rendererDir: string;
  readonly devServerUrl?: string;
  // Security wiring stays with the caller (index.ts owns the logger + dev URL);
  // applied to every window this factory creates, per security.ts.
  readonly harden: (win: BrowserWindow) => void;
}

interface SecondaryWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly htmlFile: string;
}

// SECURITY: the webPreferences here (nodeIntegration off, contextIsolation +
// sandbox on, webSecurity on, no insecure content) and the harden() call are
// the renderer sandbox for every secondary window — asserted by the window
// tests; do not weaken.
function createSecondaryWindow(
  deps: SecondaryWindowDeps,
  options: SecondaryWindowOptions
): BrowserWindow {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    frame: false,
    title: options.title,
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
    void win.loadURL(`${deps.devServerUrl}/${options.htmlFile}`);
  } else {
    void win.loadFile(path.join(deps.rendererDir, options.htmlFile));
  }
  return win;
}

// ---------------------------------------------------------------------------
// Review window: a secondary, per-repository window opened from the card
// view's Review / Merge actions with its targets and workflow preloaded; one
// instance per repository checkout (keyed by its path).
// ---------------------------------------------------------------------------

export type ReviewWindowDeps = SecondaryWindowDeps;

// The review layout is 1180px wide; the window adds chrome padding.
const REVIEW_WINDOW_SIZE = { width: 1220, height: 840 } as const;

// One review window per repository checkout; module-scoped so re-opening the
// same repository focuses/re-targets rather than duplicating, and so the open
// request can be handed back to the window on mount (requestContext).
const reviewWindows = new Map<string, { win: BrowserWindow; request: ReviewOpenRequest }>();

// This window is the only driver of a merge: it starts one on mount and owns
// resolve/complete/abort. When it closes — or is re-pointed at another workflow,
// which unmounts the merge view — an in-flight merge would be stranded on disk
// with no surface able to finish it. Fire-and-forget: window teardown must
// never wait on, or fail with, the SDK.
function abortOrphanedMerge(log: MainLogger, repositoryPath: string, operation: string): void {
  void abortActiveMerge(repositoryPath)
    .then(aborted => {
      if (aborted) {
        log.info("Aborted the review window's merge", { operation, repositoryPath });
      }
    })
    .catch((error: unknown) => {
      log.error("Failed to abort the review window's merge", { error, operation, repositoryPath });
    });
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

    // Already open for this repository: re-target the window's workflow/compare
    // and focus, rather than opening a duplicate (one per repository).
    const existing = reviewWindows.get(request.repositoryPath);
    if (existing && !existing.win.isDestroyed()) {
      if (existing.request.workflow !== request.workflow) {
        abortOrphanedMerge(log, request.repositoryPath, IPC_CHANNELS.review.open);
      }
      reviewWindows.set(request.repositoryPath, { win: existing.win, request });
      existing.win.webContents.send(IPC_CHANNELS.review.context, request);
      existing.win.focus();
      return;
    }

    const win = createSecondaryWindow(deps, {
      ...REVIEW_WINDOW_SIZE,
      title: `Review — ${request.branchName}`,
      htmlFile: 'review.html',
    });
    reviewWindows.set(request.repositoryPath, { win, request });

    win.on('closed', () => {
      reviewWindows.delete(request.repositoryPath);
      abortOrphanedMerge(log, request.repositoryPath, 'review:closed');
    });
  });

  // The review renderer pulls its open request on mount. The sender's
  // webContents identifies which window (and thus which stored request) is
  // asking, so no repository id crosses the query string.
  ipcMain.handle(
    IPC_CHANNELS.review.requestContext,
    (event: IpcMainInvokeEvent): Result<ReviewOpenRequest> => {
      for (const { win, request } of reviewWindows.values()) {
        if (!win.isDestroyed() && win.webContents === event.sender) {
          return success(request);
        }
      }
      return failure('No review context for this window');
    }
  );
}
