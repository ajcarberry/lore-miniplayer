import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { MainLogger } from '../../../src/main/ipc/logger';
import type {
  MissionControlWindowDeps,
  MissionControlModel,
} from '../../../src/main/ipc/window-handlers';

const REPO_ID = '11111111-1111-4111-8111-111111111111';

const mockLog = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
  log: jest.fn(),
} as unknown as MainLogger;

// A constructable BrowserWindow whose instances record their loads and expose a
// mutable destroyed flag; the last-constructed instance is captured for
// assertions.
jest.mock('electron', () => {
  const instances: unknown[] = [];
  class FakeBrowserWindow {
    public loadURL = jest.fn();
    public loadFile = jest.fn();
    public focus = jest.fn();
    public close = jest.fn();
    public destroyed = false;
    public webContents = { send: jest.fn() };
    private listeners = new Map<string, () => void>();
    public constructor(public readonly opts: unknown) {
      instances.push(this);
    }
    public on(event: string, listener: () => void): this {
      this.listeners.set(event, listener);
      return this;
    }
    public emit(event: string): void {
      this.listeners.get(event)?.();
    }
    public isDestroyed(): boolean {
      return this.destroyed;
    }
    public static __instances = instances;
  }
  return {
    ipcMain: { handle: jest.fn(), on: jest.fn() },
    BrowserWindow: FakeBrowserWindow,
  };
});

interface FakeWindow {
  loadURL: jest.Mock;
  loadFile: jest.Mock;
  focus: jest.Mock;
  close: jest.Mock;
  destroyed: boolean;
  webContents: { send: jest.Mock };
  emit: (event: string) => void;
  opts: { webPreferences: { preload: string } };
}

interface Harness {
  model: { [K in keyof MissionControlModel]: jest.Mock };
  harden: jest.Mock;
  getMissionControlWindow: () => FakeWindow | null;
  openListener: (event: unknown, rawRepositoryId: unknown) => void;
  closeListener: () => void;
  watchHandler: (event: unknown, ...args: unknown[]) => Promise<unknown>;
  refreshHandler: (event: unknown, ...args: unknown[]) => Promise<unknown>;
  instances: FakeWindow[];
}

function setup(overrides: Partial<MissionControlWindowDeps> = {}): Harness {
  jest.resetModules();
  jest.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as {
    ipcMain: { handle: jest.Mock; on: jest.Mock };
    BrowserWindow: { __instances: FakeWindow[] };
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wh =
    require('../../../src/main/ipc/window-handlers') as typeof import('../../../src/main/ipc/window-handlers');

  const model = {
    watch: jest.fn(),
    unwatch: jest.fn(),
    snapshot: jest.fn().mockResolvedValue({ repositoryId: REPO_ID, cards: [] }),
    refreshNow: jest.fn().mockResolvedValue(undefined),
  };
  const harden = jest.fn();
  wh.registerMissionControlWindow(mockLog, {
    preloadPath: '/app/preload.js',
    rendererDir: '/app/renderer',
    harden,
    model: model as unknown as MissionControlModel,
    ...overrides,
  });

  const findOn = (channel: string): ((event: unknown, arg: unknown) => void) => {
    const call = electron.ipcMain.on.mock.calls.find(([ch]) => ch === channel);
    if (!call) {
      throw new Error(`no on-handler for ${channel}`);
    }
    return call[1] as (event: unknown, arg: unknown) => void;
  };
  const watchCall = electron.ipcMain.handle.mock.calls.find(
    ([ch]) => ch === IPC_CHANNELS.workspaceModel.watch
  );
  if (!watchCall) {
    throw new Error('no watch handler');
  }
  const refreshCall = electron.ipcMain.handle.mock.calls.find(
    ([ch]) => ch === IPC_CHANNELS.workspaceModel.refresh
  );
  if (!refreshCall) {
    throw new Error('no refresh handler');
  }

  return {
    model,
    harden,
    getMissionControlWindow: wh.getMissionControlWindow as () => FakeWindow | null,
    openListener: findOn(IPC_CHANNELS.missionControl.open),
    closeListener: findOn(IPC_CHANNELS.missionControl.close) as () => void,
    watchHandler: watchCall[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>,
    refreshHandler: refreshCall[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>,
    instances: electron.BrowserWindow.__instances,
  };
}

describe('registerMissionControlWindow — open', () => {
  it('creates one hardened, dev-loaded window and watches the repository', () => {
    const h = setup({ devServerUrl: 'http://localhost:5173' });

    h.openListener({}, REPO_ID);

    expect(h.instances).toHaveLength(1);
    const win = h.instances[0]!;
    expect(win.opts.webPreferences.preload).toBe('/app/preload.js');
    expect(h.harden).toHaveBeenCalledWith(win);
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173/mission-control.html');
    expect(h.model.watch).toHaveBeenCalledWith(REPO_ID);
    expect(h.getMissionControlWindow()).toBe(win);
  });

  it('loads the packaged file when there is no dev server', () => {
    const h = setup();
    h.openListener({}, REPO_ID);
    expect(h.instances[0]!.loadFile).toHaveBeenCalledWith('/app/renderer/mission-control.html');
  });

  it('focuses the existing window instead of creating a second (one instance max)', () => {
    const h = setup();
    h.openListener({}, REPO_ID);
    h.openListener({}, REPO_ID);

    expect(h.instances).toHaveLength(1);
    expect(h.instances[0]!.focus).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed repository id without creating a window', () => {
    const h = setup();
    h.openListener({}, 'not-a-uuid');

    expect(h.instances).toHaveLength(0);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Invalid missionControl:open payload',
      expect.objectContaining({ operation: IPC_CHANNELS.missionControl.open })
    );
  });

  it('releases the model watch and clears the singleton when the window closes', () => {
    const h = setup();
    h.openListener({}, REPO_ID);
    h.instances[0]!.emit('closed');

    expect(h.model.unwatch).toHaveBeenCalledTimes(1);
    expect(h.getMissionControlWindow()).toBeNull();
  });
});

describe('registerMissionControlWindow — close', () => {
  it('closes the open window', () => {
    const h = setup();
    h.openListener({}, REPO_ID);
    h.closeListener();
    expect(h.instances[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no window is open', () => {
    const h = setup();
    expect(() => h.closeListener()).not.toThrow();
  });
});

describe('registerMissionControlWindow — watch handler', () => {
  it('watches and returns the current snapshot as a success result', async () => {
    const h = setup();
    const result = await h.watchHandler({}, REPO_ID);

    expect(h.model.watch).toHaveBeenCalledWith(REPO_ID);
    expect(result).toEqual({ success: true, data: { repositoryId: REPO_ID, cards: [] } });
  });

  it('returns a failure result for a malformed repository id', async () => {
    const h = setup();
    const result = await h.watchHandler({}, 'nope');
    expect(result).toMatchObject({ success: false });
    expect(h.model.watch).not.toHaveBeenCalled();
  });
});

describe('registerMissionControlWindow — manual refresh handler', () => {
  it('triggers the model refresh for the given repository and returns a void success result', async () => {
    const h = setup();
    const result = await h.refreshHandler({}, REPO_ID);

    expect(h.model.refreshNow).toHaveBeenCalledWith(REPO_ID);
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('validates the repository id the same way watch does, without calling refreshNow', async () => {
    const h = setup();
    const result = await h.refreshHandler({}, 'nope');

    expect(result).toMatchObject({ success: false });
    expect(h.model.refreshNow).not.toHaveBeenCalled();
  });

  it('surfaces a thrown refresh failure as a failure result', async () => {
    const h = setup();
    h.model.refreshNow.mockRejectedValueOnce(new Error('refresh boom'));

    const result = await h.refreshHandler({}, REPO_ID);

    expect(result).toEqual({ success: false, error: 'refresh boom' });
  });
});
