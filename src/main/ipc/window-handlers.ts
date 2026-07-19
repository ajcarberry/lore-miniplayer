import { ipcMain, BrowserWindow, screen } from 'electron';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  COLLAPSED_WINDOW_SIZE,
  EXPANDED_WINDOW_SIZE,
  computeCollapsedBounds,
  computeExpandedBounds,
} from '../../shared/window-position';
import type { Bounds, ExpandAnchor } from '../../shared/window-position';
import { handleResult } from './result-helpers';
import { WindowOpenTerminalArgsSchema } from './validators';
import type { MainLogger } from './logger';

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
