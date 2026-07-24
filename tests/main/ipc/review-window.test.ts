import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { MainLogger } from '../../../src/main/ipc/logger';
import type { ReviewWindowDeps } from '../../../src/main/ipc/window-handlers';
import type { ReviewOpenRequest } from '../../../src/shared/types';

const REPO_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest(overrides: Partial<ReviewOpenRequest> = {}): ReviewOpenRequest {
  return {
    workspacePath: '/wt/act2-balance',
    repositoryId: REPO_ID,
    branchName: 'agent/act2-balance',
    workflow: 'commit',
    compare: {
      source: { kind: 'revision', revision: 'r128' },
      target: { kind: 'workingTree' },
    },
    ...overrides,
  };
}

const mockLog = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
  log: jest.fn(),
} as unknown as MainLogger;

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
  opts: { title: string; webPreferences: { preload: string } };
}

interface Harness {
  harden: jest.Mock;
  openListener: (event: unknown, rawRequest: unknown) => void;
  contextHandler: (event: unknown) => Promise<unknown>;
  instances: FakeWindow[];
}

function setup(overrides: Partial<ReviewWindowDeps> = {}): Harness {
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

  const harden = jest.fn();
  wh.registerReviewWindow(mockLog, {
    preloadPath: '/app/preload.js',
    rendererDir: '/app/renderer',
    harden,
    ...overrides,
  });

  const findOn = (channel: string): ((event: unknown, arg: unknown) => void) => {
    const call = electron.ipcMain.on.mock.calls.find(([ch]) => ch === channel);
    if (!call) {
      throw new Error(`no on-handler for ${channel}`);
    }
    return call[1] as (event: unknown, arg: unknown) => void;
  };
  const contextCall = electron.ipcMain.handle.mock.calls.find(
    ([ch]) => ch === IPC_CHANNELS.review.requestContext
  );
  if (!contextCall) {
    throw new Error('no requestContext handler');
  }

  return {
    harden,
    openListener: findOn(IPC_CHANNELS.review.open),
    contextHandler: contextCall[1] as (event: unknown) => Promise<unknown>,
    instances: electron.BrowserWindow.__instances,
  };
}

describe('registerReviewWindow — open', () => {
  it('creates one hardened, dev-loaded window titled for the review', () => {
    const h = setup({ devServerUrl: 'http://localhost:5173' });

    h.openListener({}, makeRequest());

    expect(h.instances).toHaveLength(1);
    const win = h.instances[0]!;
    expect(win.opts.webPreferences.preload).toBe('/app/preload.js');
    expect(win.opts.title).toBe('Review — agent/act2-balance');
    expect(h.harden).toHaveBeenCalledWith(win);
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173/review.html');
  });

  it('loads the packaged file when there is no dev server', () => {
    const h = setup();
    h.openListener({}, makeRequest());
    expect(h.instances[0]!.loadFile).toHaveBeenCalledWith('/app/renderer/review.html');
  });

  it('focuses and re-targets the existing window for the same workspace (one per workspace)', () => {
    const h = setup();
    h.openListener({}, makeRequest());
    h.openListener({}, makeRequest({ workflow: 'merge' }));

    expect(h.instances).toHaveLength(1);
    const win = h.instances[0]!;
    expect(win.focus).toHaveBeenCalledTimes(1);
    // Re-targeting pushes the new request to the already-open window.
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.review.context,
      expect.objectContaining({ workflow: 'merge' })
    );
  });

  it('opens a second window for a different workspace', () => {
    const h = setup();
    h.openListener({}, makeRequest());
    h.openListener({}, makeRequest({ workspacePath: '/wt/other', branchName: 'agent/other' }));
    expect(h.instances).toHaveLength(2);
  });

  it('rejects a malformed request without creating a window', () => {
    const h = setup();
    h.openListener({}, { workspacePath: '' });

    expect(h.instances).toHaveLength(0);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Invalid review:open payload',
      expect.objectContaining({ operation: IPC_CHANNELS.review.open })
    );
  });

  it('clears the per-workspace entry when the window closes', () => {
    const h = setup();
    h.openListener({}, makeRequest());
    h.instances[0]!.emit('closed');

    // Re-opening the same workspace creates a fresh window rather than
    // re-targeting the closed one.
    h.openListener({}, makeRequest());
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0]!.focus).not.toHaveBeenCalled();
  });
});

describe('registerReviewWindow — requestContext', () => {
  it('returns the stored request to the window that owns the sender', async () => {
    const h = setup();
    h.openListener({}, makeRequest());
    const win = h.instances[0]!;

    const result = await h.contextHandler({ sender: win.webContents });

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ workspacePath: '/wt/act2-balance', workflow: 'commit' }),
    });
  });

  it('returns a failure when the sender has no review context', async () => {
    const h = setup();
    const result = await h.contextHandler({ sender: { send: jest.fn() } });
    expect(result).toMatchObject({ success: false });
  });
});
