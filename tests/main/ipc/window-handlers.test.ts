// Mock electron module before imports
jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: {
    fromWebContents: jest.fn(),
  },
  screen: {
    getDisplayMatching: jest.fn(),
  },
}));

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

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ipcMain, BrowserWindow, screen } from 'electron';
import {
  attachFocusDimming,
  computeFocusOpacity,
  openTerminal,
  registerWindowHandlers,
} from '../../../src/main/ipc/window-handlers';
import type { MainLogger } from '../../../src/main/ipc/logger';

type FakeChild = EventEmitter & { unref: jest.Mock };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.unref = jest.fn();
  return child;
}

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('openTerminal', () => {
  // A real directory whose name contains shell/AppleScript metacharacters —
  // command substitution, backticks, double quotes, and a backslash. If any
  // launcher builds a shell string from the path, these would execute.
  // NTFS filenames cannot contain " or \, so on a Windows host the template
  // drops them and keeps the PowerShell-hostile set instead.
  let hostileDir: string;

  beforeAll(async () => {
    const template =
      process.platform === 'win32'
        ? 'lore-$(touch pwned)-`id`-&;-'
        : 'lore-$(touch pwned)-`id`-"\\-';
    hostileDir = await fs.mkdtemp(path.join(os.tmpdir(), template));
  });

  afterAll(async () => {
    await fs.rm(hostileDir, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('darwin', () => {
    it('should pass the directory as a standalone argv element, never inside a shell string', async () => {
      // Given: a directory containing shell metacharacters and a spawn that exits cleanly
      mockSpawn.mockImplementation(() => {
        const child = fakeChild();
        setTimeout(() => child.emit('close', 0), 0);
        return child as never;
      });

      // When: the terminal is opened on macOS
      await openTerminal(hostileDir, 'darwin');

      // Then: the path is its own argv element of an argv-safe launcher —
      // no argument embeds the path inside a larger command string
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [command, argv] = mockSpawn.mock.calls[0]! as unknown as [string, string[]];
      expect(command).toBe('open');
      expect(argv).toEqual(['-a', 'Terminal', hostileDir]);
    });

    it('should reject when the launcher exits with a non-zero code', async () => {
      // Given: the launcher fails
      mockSpawn.mockImplementation(() => {
        const child = fakeChild();
        setTimeout(() => child.emit('close', 1));
        return child as never;
      });

      // When/Then: the promise rejects
      await expect(openTerminal(hostileDir, 'darwin')).rejects.toThrow(/exited with code 1/);
    });
  });

  describe('linux', () => {
    it('should pass the directory to gnome-terminal as a flag value, not a shell string', async () => {
      // Given: gnome-terminal launches and closes
      mockSpawn.mockImplementation(() => {
        const child = fakeChild();
        setTimeout(() => child.emit('close', 0), 0);
        return child as never;
      });

      // When: the terminal is opened on Linux
      await openTerminal(hostileDir, 'linux');

      // Then: the path rides in the --working-directory flag verbatim
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [command, argv] = mockSpawn.mock.calls[0]! as unknown as [string, string[]];
      expect(command).toBe('gnome-terminal');
      expect(argv).toEqual([`--working-directory=${hostileDir}`]);
    });

    it('should fall back to xterm started via cwd with no shell command built from the path', async () => {
      // Given: gnome-terminal is missing and xterm spawns successfully
      mockSpawn.mockImplementation((command: string) => {
        const child = fakeChild();
        if (command === 'gnome-terminal') {
          setTimeout(() => child.emit('error', new Error('ENOENT')));
        } else {
          setTimeout(() => child.emit('spawn'));
        }
        return child as never;
      });

      // When: the terminal is opened on Linux
      await openTerminal(hostileDir, 'linux');

      // Then: xterm receives no command arguments; the directory is set via cwd
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const [command, argv, options] = mockSpawn.mock.calls[1]! as unknown as [
        string,
        string[],
        { cwd?: string },
      ];
      expect(command).toBe('xterm');
      expect(argv).toEqual([]);
      expect(options.cwd).toBe(hostileDir);
    });

    it('should reject when the xterm fallback also fails to spawn', async () => {
      // Given: neither terminal is available
      mockSpawn.mockImplementation(() => {
        const child = fakeChild();
        setTimeout(() => child.emit('error', new Error('ENOENT')));
        return child as never;
      });

      // When/Then: the promise rejects instead of resolving optimistically
      await expect(openTerminal(hostileDir, 'linux')).rejects.toThrow('ENOENT');
    });
  });

  describe('win32', () => {
    it('should pass the location through an argv array with the shell disabled', async () => {
      // Given: a detached PowerShell launch
      mockSpawn.mockImplementation(() => fakeChild() as never);

      // When: the terminal is opened on Windows
      await openTerminal(hostileDir, 'win32');

      // Then: argv array form with shell:false — single quotes doubled for -LiteralPath
      const [command, argv, options] = mockSpawn.mock.calls[0]! as unknown as [
        string,
        string[],
        { shell?: boolean },
      ];
      expect(command).toBe('cmd.exe');
      expect(argv).toContain('-NoExit');
      expect(options.shell).toBe(false);
    });
  });

  it('should reject when the path is not a directory', async () => {
    // Given: a file rather than a directory
    const file = path.join(hostileDir, 'a-file.txt');
    await fs.writeFile(file, 'x');

    // When/Then: validation fails before any spawn
    await expect(openTerminal(file, 'darwin')).rejects.toThrow('Directory does not exist');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// A minimal window double for the focus-dimming logic: real event emitter
// (blur/focus), mocked opacity and focus state.
type FakeWindow = EventEmitter & {
  setOpacity: jest.Mock;
  isFocused: jest.Mock;
};

function fakeWindow(focused: boolean): FakeWindow {
  const win = new EventEmitter() as FakeWindow;
  win.setOpacity = jest.fn();
  win.isFocused = jest.fn().mockReturnValue(focused);
  return win;
}

// Register the handlers and return the listener for window:setNoticeActive.
function noticeListener(): (event: unknown, rawActive: unknown) => void {
  registerWindowHandlers(mockLog as unknown as MainLogger);
  const call = (ipcMain.on as jest.Mock).mock.calls.find(
    ([channel]) => channel === 'window:setNoticeActive'
  );
  expect(call).toBeDefined();
  return call![1] as (event: unknown, rawActive: unknown) => void;
}

function sendNotice(
  listener: (event: unknown, rawActive: unknown) => void,
  win: FakeWindow,
  rawActive: unknown
): void {
  (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(win);
  listener({ sender: {} }, rawActive);
}

describe('computeFocusOpacity', () => {
  it('is fully opaque when focused and no notice is active', () => {
    // Given: a focused window with no active notice
    // When: the opacity decision is computed
    const opacity = computeFocusOpacity({ focused: true, noticeActive: false });

    // Then: full opacity
    expect(opacity).toBe(1.0);
  });

  it('is fully opaque when focused and a notice is active', () => {
    // Given: a focused window with an active notice
    // When: the opacity decision is computed
    const opacity = computeFocusOpacity({ focused: true, noticeActive: true });

    // Then: full opacity
    expect(opacity).toBe(1.0);
  });

  it('dims to 70% when unfocused and no notice is active', () => {
    // Given: an unfocused window with no active notice
    // When: the opacity decision is computed
    const opacity = computeFocusOpacity({ focused: false, noticeActive: false });

    // Then: dimmed opacity
    expect(opacity).toBe(0.7);
  });

  it('stays fully opaque when unfocused but a notice is active', () => {
    // Given: an unfocused window with an active notice
    // When: the opacity decision is computed
    const opacity = computeFocusOpacity({ focused: false, noticeActive: true });

    // Then: the notice suspends dimming
    expect(opacity).toBe(1.0);
  });
});

describe('focus dimming with notice override', () => {
  it('dims to 70% on blur and restores full opacity on focus while no notice is active', () => {
    // Given: an attached window with the notice explicitly cleared
    const win = fakeWindow(false);
    sendNotice(noticeListener(), win, false);
    win.setOpacity.mockClear();
    attachFocusDimming(win as unknown as BrowserWindow);

    // When: the window blurs
    win.emit('blur');

    // Then: it dims
    expect(win.setOpacity).toHaveBeenLastCalledWith(0.7);

    // When: the window regains focus
    win.isFocused.mockReturnValue(true);
    win.emit('focus');

    // Then: it is fully opaque again
    expect(win.setOpacity).toHaveBeenLastCalledWith(1.0);
  });

  it('stays fully opaque on blur while the notice is active', () => {
    // Given: an attached, unfocused window whose renderer reported an active notice
    const win = fakeWindow(false);
    sendNotice(noticeListener(), win, true);
    attachFocusDimming(win as unknown as BrowserWindow);

    // When: the window blurs
    win.emit('blur');

    // Then: no dimming — the notice pulse must stay visible
    expect(win.setOpacity).toHaveBeenLastCalledWith(1.0);
  });

  it('re-applies opacity immediately when the notice flag changes', () => {
    // Given: an unfocused window that is dimmed with no notice
    const win = fakeWindow(false);
    const listener = noticeListener();
    sendNotice(listener, win, false);
    expect(win.setOpacity).toHaveBeenLastCalledWith(0.7);

    // When: the notice activates while still unfocused
    sendNotice(listener, win, true);

    // Then: the window un-dims right away (no blur/focus event needed)
    expect(win.setOpacity).toHaveBeenLastCalledWith(1.0);

    // When: the notice clears while still unfocused
    sendNotice(listener, win, false);

    // Then: normal dimming resumes
    expect(win.setOpacity).toHaveBeenLastCalledWith(0.7);
  });

  it('logs and ignores an invalid notice payload', () => {
    // Given: a registered handler and a window with a known notice state
    const win = fakeWindow(false);
    const listener = noticeListener();
    sendNotice(listener, win, false);
    win.setOpacity.mockClear();

    // When: the renderer sends a non-boolean payload
    sendNotice(listener, win, 'yes');

    // Then: it is logged and the opacity is left untouched
    expect(mockLog.error).toHaveBeenCalledWith(
      'Invalid setNoticeActive payload',
      expect.objectContaining({ operation: 'window:setNoticeActive' })
    );
    expect(win.setOpacity).not.toHaveBeenCalled();
  });
});

// A minimal window double for the card ↔ review morph: mocked bounds and
// always-on-top state.
type FakeViewWindow = {
  getBounds: jest.Mock;
  setBounds: jest.Mock;
  setResizable: jest.Mock;
  isResizable: jest.Mock;
  setAlwaysOnTop: jest.Mock;
};

function fakeViewWindow(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): FakeViewWindow {
  return {
    getBounds: jest.fn().mockReturnValue(bounds),
    setBounds: jest.fn(),
    setResizable: jest.fn(),
    isResizable: jest.fn().mockReturnValue(false),
    setAlwaysOnTop: jest.fn(),
  };
}

describe('window:setView (card ↔ Project View morph)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function setViewHandler(): (event: unknown, rawView: unknown) => unknown {
    registerWindowHandlers(mockLog as unknown as MainLogger);
    const call = (ipcMain.handle as jest.Mock).mock.calls.find(
      ([channel]) => channel === 'window:setView'
    );
    expect(call).toBeDefined();
    return call![1] as (event: unknown, rawView: unknown) => unknown;
  }

  const CARD_BOUNDS = { x: 1000, y: 195, width: 360, height: 680 };
  const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

  function install(win: FakeViewWindow): (event: unknown, rawView: unknown) => unknown {
    const handler = setViewHandler();
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(win);
    (screen.getDisplayMatching as jest.Mock).mockReturnValue({ workArea: WORK_AREA });
    return handler;
  }

  it('grows to the review footprint and stops floating above other windows', () => {
    // Given: a card-sized window
    const win = fakeViewWindow(CARD_BOUNDS);
    const handler = install(win);

    // When: morphing to the Project View
    handler({ sender: {} }, 'projectView');

    // Then: the window takes the anchored, clamped review bounds and drops
    // always-on-top (the ambient pill behavior returns with the card)
    expect(win.setBounds).toHaveBeenCalledWith({ x: 140, y: 35, width: 1220, height: 840 });
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(false);
  });

  it('restores the remembered card bounds and always-on-top on the way back', () => {
    // Given: a window that morphed to the Project View from known card bounds
    const win = fakeViewWindow(CARD_BOUNDS);
    const handler = install(win);
    handler({ sender: {} }, 'projectView');
    win.setBounds.mockClear();

    // When: morphing back to the card
    handler({ sender: {} }, 'card');

    // Then: the exact pre-review card bounds return, floating again
    expect(win.setBounds).toHaveBeenCalledWith(CARD_BOUNDS);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  });

  it('leaves the bounds alone on a card request with nothing to restore', () => {
    // Given: a window that never entered the Project View
    const win = fakeViewWindow(CARD_BOUNDS);
    const handler = install(win);

    // When: asking for the card view
    handler({ sender: {} }, 'card');

    // Then: no resize happens (still always-on-top as the ambient default)
    expect(win.setBounds).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true);
  });

  it('logs and ignores an invalid view payload', () => {
    // Given: a registered handler
    const win = fakeViewWindow(CARD_BOUNDS);
    const handler = install(win);

    // When: an unknown view name arrives
    handler({ sender: {} }, 'fullscreen');

    // Then: nothing moves and the error is logged
    expect(win.setBounds).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalled();
  });
});
