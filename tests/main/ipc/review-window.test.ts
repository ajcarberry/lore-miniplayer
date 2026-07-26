import { IPC_CHANNELS } from '../../../src/shared/schemas';
import type { MainLogger } from '../../../src/main/ipc/logger';
import type { ReviewWindowDeps } from '../../../src/main/ipc/window-handlers';
import type { ReviewOpenRequest } from '../../../src/shared/types';

const REPO_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest(overrides: Partial<ReviewOpenRequest> = {}): ReviewOpenRequest {
  return {
    repositoryPath: '/repos/my-repo',
    repositoryId: REPO_ID,
    branchName: 'feat/topic',
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
  // The same merge-registry module instance window-handlers resolved after
  // resetModules — a top-level import would be a different copy.
  registry: typeof import('../../../src/main/services/merge-registry');
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry =
    require('../../../src/main/services/merge-registry') as typeof import('../../../src/main/services/merge-registry');

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
    registry,
  };
}

describe('registerReviewWindow — open', () => {
  it('creates one hardened, dev-loaded window titled for the review', () => {
    const h = setup({ devServerUrl: 'http://localhost:5173' });

    h.openListener({}, makeRequest());

    expect(h.instances).toHaveLength(1);
    const win = h.instances[0]!;
    expect(win.opts.webPreferences.preload).toBe('/app/preload.js');
    expect(win.opts.title).toBe('Review — feat/topic');
    expect(h.harden).toHaveBeenCalledWith(win);
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173/review.html');
  });

  it('loads the packaged file when there is no dev server', () => {
    const h = setup();
    h.openListener({}, makeRequest());
    expect(h.instances[0]!.loadFile).toHaveBeenCalledWith('/app/renderer/review.html');
  });

  it('focuses and re-targets the existing window for the same repository (one per repository)', () => {
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

  it('opens a second window for a different repository', () => {
    const h = setup();
    h.openListener({}, makeRequest());
    h.openListener({}, makeRequest({ repositoryPath: '/repos/other', branchName: 'feat/other' }));
    expect(h.instances).toHaveLength(2);
  });

  it('rejects a malformed request without creating a window', () => {
    const h = setup();
    h.openListener({}, { repositoryPath: '' });

    expect(h.instances).toHaveLength(0);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Invalid review:open payload',
      expect.objectContaining({ operation: IPC_CHANNELS.review.open })
    );
  });

  it('clears the per-repository entry when the window closes', () => {
    const h = setup();
    h.openListener({}, makeRequest());
    h.instances[0]!.emit('closed');

    // Re-opening the same repository creates a fresh window rather than
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
      data: expect.objectContaining({ repositoryPath: '/repos/my-repo', workflow: 'commit' }),
    });
  });

  it('returns a failure when the sender has no review context', async () => {
    const h = setup();
    const result = await h.contextHandler({ sender: { send: jest.fn() } });
    expect(result).toMatchObject({ success: false });
  });
});

// The review window is the only driver of a merge: it starts one on mount and
// owns resolve/complete/abort. If it goes away (or is re-pointed at another
// workflow) with a merge in flight, the merge is stranded on disk with no UI
// able to finish it (amendment bug A2).
describe('registerReviewWindow — orphaned merges', () => {
  function mergeRequest(): ReviewOpenRequest {
    return makeRequest({ workflow: 'merge' });
  }

  it("aborts the workspace's in-flight merge when the window closes", async () => {
    const h = setup();
    const abort = jest.fn(async () => undefined);
    h.openListener({}, mergeRequest());
    h.registry.registerActiveMerge('/repos/my-repo', abort);

    h.instances[0]!.emit('closed');
    await flushMicrotasks();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the in-flight merge when the window is re-targeted at another workflow', async () => {
    const h = setup();
    const abort = jest.fn(async () => undefined);
    h.openListener({}, mergeRequest());
    h.registry.registerActiveMerge('/repos/my-repo', abort);

    // When: Mission Control re-points the same window at the commit workflow —
    // the merge view unmounts and nothing would ever finish the merge
    h.openListener({}, makeRequest({ workflow: 'commit' }));
    await flushMicrotasks();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(h.instances[0]!.webContents.send).toHaveBeenCalled();
  });

  it('leaves the merge alone when the window is re-targeted at the same workflow', async () => {
    const h = setup();
    const abort = jest.fn(async () => undefined);
    h.openListener({}, mergeRequest());
    h.registry.registerActiveMerge('/repos/my-repo', abort);

    // Re-opening the same merge focuses the window without remounting the view
    h.openListener({}, mergeRequest());
    await flushMicrotasks();

    expect(abort).not.toHaveBeenCalled();
  });

  it('logs an abort failure instead of breaking window teardown', async () => {
    const h = setup();
    h.openListener({}, mergeRequest());
    h.registry.registerActiveMerge('/repos/my-repo', async () => {
      throw new Error('no merge in progress');
    });

    expect(() => h.instances[0]!.emit('closed')).not.toThrow();
    await flushMicrotasks();

    expect(mockLog.error).toHaveBeenCalledWith(
      "Failed to abort the review window's merge",
      expect.objectContaining({ repositoryPath: '/repos/my-repo' })
    );
  });
});

// The abort is fire-and-forget, so its promise chain settles a few microtasks
// after the window event.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
