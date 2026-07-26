import { ipcMain, BrowserWindow, screen } from 'electron';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  COLLAPSED_WINDOW_SIZE,
  EXPANDED_WINDOW_SIZE,
  REVIEW_VIEW_SIZE,
  computeCollapsedBounds,
  computeExpandedBounds,
  computeReviewBounds,
} from '../../shared/window-position';
import type { Bounds, ExpandAnchor } from '../../shared/window-position';
import { handleResult } from './result-helpers';
import { WindowNoticeActiveSchema, WindowOpenTerminalArgsSchema } from './validators';
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

  // The card ↔ Project View morph: while the Project View is open the window
  // grows to the review footprint (anchored like the card morph, clamped to
  // the work area) and stops floating above other windows — a near-fullscreen
  // always-on-top surface would be obnoxious; the ambient behavior returns
  // with the card. The card's exact bounds are remembered and restored.
  let cardBoundsBeforeReview: Bounds | null = null;
  ipcMain.handle('window:setView', (event, rawView: unknown): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if ((rawView !== 'card' && rawView !== 'projectView') || !win) {
      if (rawView !== 'card' && rawView !== 'projectView') {
        log.error('Invalid setView payload', { rawView, operation: 'window:setView' });
      }
      return;
    }
    if (rawView === 'projectView') {
      const current = win.getBounds();
      cardBoundsBeforeReview = current;
      const workArea = screen.getDisplayMatching(current).workArea;
      setBoundsAllowingResize(
        win,
        computeReviewBounds(current, REVIEW_VIEW_SIZE, lastAnchor, workArea)
      );
      win.setAlwaysOnTop(false);
      return;
    }
    if (cardBoundsBeforeReview !== null) {
      setBoundsAllowingResize(win, cardBoundsBeforeReview);
      cardBoundsBeforeReview = null;
    }
    win.setAlwaysOnTop(true);
  });

  handleResult(log, 'window:open-terminal', WindowOpenTerminalArgsSchema, workingDirectory =>
    openTerminal(workingDirectory)
  );
}
