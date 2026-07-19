import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const registeredHandlers = new Map<string, IpcHandler>();
const mockUserData = { dir: '' };

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn((channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  app: {
    getPath: (): string => mockUserData.dir,
  },
}));

jest.mock('electron-log/main.js', () => ({
  __esModule: true,
  default: { error: jest.fn(), initialize: jest.fn() },
}));

import log from 'electron-log/main.js';
import {
  registerConfigHandlers,
  loadWindowPosition,
  saveWindowPosition,
} from '../../../src/main/ipc/config-handlers';

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(undefined, ...args);
}

describe('config IPC handlers', () => {
  beforeEach(() => {
    mockUserData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-miniplayer-config-test-'));
    registeredHandlers.clear();
    registerConfigHandlers(log);
  });

  afterEach(() => {
    fs.rmSync(mockUserData.dir, { recursive: true, force: true });
  });

  it('should default themeMode to auto before anything is persisted', async () => {
    // When: requesting config with nothing persisted yet
    const result = await invoke('config:get');

    // Then: themeMode defaults to 'auto'
    expect(result).toMatchObject({ success: true, data: { themeMode: 'auto' } });
  });

  it('should round-trip themeMode through config:set and config:get', async () => {
    // Given: a valid themeMode update
    // When: setting themeMode to 'dark'
    const setResult = await invoke('config:set', { themeMode: 'dark' });

    // Then: the handler returns the updated config
    expect(setResult).toMatchObject({ success: true, data: { themeMode: 'dark' } });

    // And: a fresh config:get reflects the persisted value
    const after = await invoke('config:get');
    expect(after).toMatchObject({ success: true, data: { themeMode: 'dark' } });
  });

  it('should reject an invalid themeMode value and persist nothing', async () => {
    // When: setting an invalid themeMode
    const result = (await invoke('config:set', { themeMode: 'neon' })) as { success: boolean };

    // Then: the update is rejected as a failure result
    expect(result.success).toBe(false);

    // And: the stored config is unchanged
    const after = await invoke('config:get');
    expect(after).toMatchObject({ success: true, data: { themeMode: 'auto' } });
  });

  describe('window position', () => {
    it('round-trips an integer windowPosition through config:set and config:get', async () => {
      // When: persisting a window position
      const setResult = await invoke('config:set', { windowPosition: { x: 120, y: 340 } });

      // Then: the handler echoes it back
      expect(setResult).toMatchObject({
        success: true,
        data: { windowPosition: { x: 120, y: 340 } },
      });

      // And: a fresh read reflects it
      const after = await invoke('config:get');
      expect(after).toMatchObject({ success: true, data: { windowPosition: { x: 120, y: 340 } } });
    });

    it('rejects a non-integer windowPosition', async () => {
      // When: persisting a fractional coordinate
      const result = (await invoke('config:set', {
        windowPosition: { x: 1.5, y: 2 },
      })) as { success: boolean };

      // Then: it is rejected and nothing is stored
      expect(result.success).toBe(false);
      const after = (await invoke('config:get')) as { data?: { windowPosition?: unknown } };
      expect(after.data?.windowPosition).toBeUndefined();
    });

    it('loadWindowPosition returns null before anything is saved', async () => {
      // When: loading with nothing persisted
      const position = await loadWindowPosition(log);

      // Then: it reports no saved position
      expect(position).toBeNull();
    });

    it('saveWindowPosition persists a position that loadWindowPosition reads back', async () => {
      // When: saving a position
      await saveWindowPosition({ x: 42, y: 7 }, log);

      // Then: it can be loaded again
      expect(await loadWindowPosition(log)).toEqual({ x: 42, y: 7 });
    });

    it('saveWindowPosition preserves other persisted config keys', async () => {
      // Given: an existing themeMode
      await invoke('config:set', { themeMode: 'dark' });

      // When: saving a window position
      await saveWindowPosition({ x: 10, y: 20 }, log);

      // Then: both the theme mode and the position survive
      const after = (await invoke('config:get')) as {
        data?: { themeMode?: string; windowPosition?: { x: number; y: number } };
      };
      expect(after.data?.themeMode).toBe('dark');
      expect(after.data?.windowPosition).toEqual({ x: 10, y: 20 });
    });
  });
});
