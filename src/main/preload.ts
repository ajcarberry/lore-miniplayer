import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/schemas';
import type {
  Config,
  Repository,
  RepositoryCreateInput,
  RepositoryUpdateInput,
  LoreBranch,
  LoreRepositoryStatus,
  LoreSyncOptions,
  LoreFileStatusGroup,
  BranchDivergence,
  BranchGraph,
  Result,
  VoidResult,
  WorkspaceProvisionRequest,
  WorkspaceProvisionResponse,
  WorkspaceTeardownRequest,
  WorkspaceMarkActiveRequest,
  WorkspaceMarkActiveResponse,
  WorkspaceForgetRequest,
  DiffRequest,
  DiffResponse,
  MergeStartRequest,
  MergeStartResponse,
  MergeResolveRequest,
  MergeResolveResponse,
  MergeAbortRequest,
  MergeAbortResponse,
  MergeCompleteRequest,
  MergeCompleteResponse,
  ReviewOpenRequest,
  WorkspaceModelSnapshot,
} from '../shared/types';

// Subscription factory for the one-way push channels from main. The returned
// subscribe function wraps the callback so the IpcRendererEvent never crosses
// the bridge, and returns an unsubscribe. Payloads cross as unknown and are
// Zod-validated in the renderer before use.
function makePushSubscription(
  channel: string
): (callback: (payload: unknown) => void) => () => void {
  return callback => {
    const listener = (_event: unknown, payload: unknown): void => {
      callback(payload);
    };
    ipcRenderer.on(channel, listener);
    return (): void => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

// Invoke helper shared by every request/response method below: the cast is
// the same one each hand-written wrapper used to carry. Each api method stays
// a typed arrow so `typeof api` (the renderer's Window contract — see
// src/types/global.d.ts) keeps full parameter and return types.
const inv = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api = {
  config: {
    get: (): Promise<Result<Config>> => inv('config:get'),
    set: (update: Partial<Config>): Promise<Result<Config>> => inv('config:set', update),
  },
  window: {
    minimize: (): void => {
      ipcRenderer.send('window:minimize');
    },
    close: (): void => {
      ipcRenderer.send('window:close');
    },
    move: (x: number, y: number): void => {
      ipcRenderer.send('window:move', x, y);
    },
    setNoticeActive: (active: boolean): void => {
      ipcRenderer.send('window:setNoticeActive', active);
    },
    setExpanded: (expanded: boolean): Promise<{ anchor: 'bottom' | 'top' }> =>
      inv('window:setExpanded', expanded),
    openTerminal: (path: string): Promise<VoidResult> => inv('window:open-terminal', path),
  },
  repository: {
    // includeProvisioned surfaces every registry origin (provisioned
    // worktrees included); omitted keeps the default card-view-only list.
    list: (includeProvisioned?: boolean): Promise<Result<Repository[]>> =>
      inv('repository:list', includeProvisioned),
    create: (input: RepositoryCreateInput): Promise<Result<Repository>> =>
      inv('repository:create', input),
    update: (input: RepositoryUpdateInput): Promise<Result<Repository>> =>
      inv('repository:update', input),
    delete: (id: string): Promise<VoidResult> => inv('repository:delete', id),
    selectDirectory: (): Promise<Result<string | null>> => inv('repository:select-directory'),
    openInExplorer: (path: string): Promise<VoidResult> => inv('repository:open-in-explorer', path),
  },
  lore: {
    branchInfo: (repositoryPath: string, branch: string): Promise<Result<BranchDivergence>> =>
      inv('lore:branchInfo', { repositoryPath, branch }),
    branchGraph: (repositoryPath: string, branch: string): Promise<Result<BranchGraph>> =>
      inv('lore:branchGraph', { repositoryPath, branch }),
    currentRevision: (repositoryPath: string): Promise<Result<string>> =>
      inv('lore:currentRevision', repositoryPath),
    repository: {
      listBranches: (repositoryPath: string): Promise<Result<LoreBranch[]>> =>
        inv('lore:branches:list', repositoryPath),
      listRemoteRepositories: (
        serverAddress: string
      ): Promise<Result<{ name: string; url: string }[]>> =>
        inv('lore:repository:list-remote', serverAddress),
      checkStatus: (localPath: string): Promise<Result<LoreRepositoryStatus>> =>
        inv('lore:repository:status', localPath),
      clone: (repositoryUrl: string, localPath: string): Promise<VoidResult> =>
        inv('lore:repository:clone', repositoryUrl, localPath),
      // One-way push channel from main streaming clone progress.
      onCloneProgress: makePushSubscription('lore:repository:clone-progress'),
      sync: (
        repositoryPath: string,
        targetBranch?: string,
        options?: LoreSyncOptions
      ): Promise<VoidResult> => inv('lore:repository:sync', repositoryPath, targetBranch, options),
      commit: (repositoryPath: string, message: string): Promise<VoidResult> =>
        inv('lore:repository:commit', repositoryPath, message),
      push: (repositoryPath: string): Promise<VoidResult> =>
        inv('lore:repository:push', repositoryPath),
    },
    notifications: {
      subscribe: (repositoryPath: string): Promise<VoidResult> =>
        inv('lore:notifications:subscribe', repositoryPath),
      unsubscribe: (repositoryPath: string): Promise<VoidResult> =>
        inv('lore:notifications:unsubscribe', repositoryPath),
      // One-way push channel from main.
      onNotification: makePushSubscription('lore:notification'),
    },
    files: {
      getStatus: (repositoryPath: string): Promise<Result<LoreFileStatusGroup>> =>
        inv('lore:files:status', repositoryPath),
      // Stage/unstage take repo-relative file paths (as reported by
      // getStatus); the main process joins them against repositoryPath.
      stage: (repositoryPath: string, filePaths: string[]): Promise<VoidResult> =>
        inv('lore:files:stage', repositoryPath, filePaths),
      unstage: (repositoryPath: string, filePaths: string[]): Promise<VoidResult> =>
        inv('lore:files:unstage', repositoryPath, filePaths),
    },
  },
  path: {
    join: (segments: string[]): Promise<Result<string>> => inv('path:join', { segments }),
    basename: (path: string): Promise<Result<string>> => inv('path:basename', { path }),
  },
  // Workspace lifecycle (Mission Control, design 2a). Teardown is destructive
  // and double-guarded in the main process; the renderer confirms first.
  workspace: {
    provision: (request: WorkspaceProvisionRequest): Promise<Result<WorkspaceProvisionResponse>> =>
      inv(IPC_CHANNELS.workspace.provision, request),
    teardown: (request: WorkspaceTeardownRequest): Promise<VoidResult> =>
      inv(IPC_CHANNELS.workspace.teardown, request),
    // Manual idle → awaiting-review transition (design 2a "mark active");
    // owned by the workspace model in the main process.
    markActive: (
      request: WorkspaceMarkActiveRequest
    ): Promise<Result<WorkspaceMarkActiveResponse>> =>
      inv(IPC_CHANNELS.workspace.markActive, request),
    // Untrack-only removal (design amendment): drops the workspace from the
    // registry without touching the worktree directory or the branch.
    forget: (request: WorkspaceForgetRequest): Promise<VoidResult> =>
      inv(IPC_CHANNELS.workspace.forget, request),
  },
  // Mission Control window (P10, design 2a). `open` manages the secondary
  // window; `watch` points the workspace model at a repository and returns its
  // current snapshot; `onSnapshot` subscribes to subsequent model rebuilds
  // (payload crosses the bridge as unknown, Zod-validated in the renderer
  // before use).
  missionControl: {
    open: (repositoryId?: string): void => {
      ipcRenderer.send(IPC_CHANNELS.missionControl.open, repositoryId);
    },
    watch: (repositoryId: string): Promise<Result<WorkspaceModelSnapshot>> =>
      inv(IPC_CHANNELS.workspaceModel.watch, repositoryId),
    refresh: (repositoryId: string): Promise<VoidResult> =>
      inv(IPC_CHANNELS.workspaceModel.refresh, repositoryId),
    onSnapshot: makePushSubscription(IPC_CHANNELS.workspaceModel.snapshot),
  },
  // The review window's compare picker (design 2b).
  diff: {
    compare: (request: DiffRequest): Promise<Result<DiffResponse>> =>
      inv(IPC_CHANNELS.diff.compare, request),
  },
  // Review window (P11, design 2b/2c). `open` creates or re-targets the
  // per-workspace secondary window with its workflow + compare preloaded;
  // `requestContext` lets the window pull its open request on mount; `onContext`
  // subscribes to re-targets of an already-open window (payload crosses the
  // bridge as unknown, Zod-validated in the renderer before use).
  review: {
    open: (request: ReviewOpenRequest): void => {
      ipcRenderer.send(IPC_CHANNELS.review.open, request);
    },
    requestContext: (): Promise<Result<ReviewOpenRequest>> =>
      inv(IPC_CHANNELS.review.requestContext),
    onContext: makePushSubscription(IPC_CHANNELS.review.context),
  },
  // The review window's merge workflow (design 2c): start a branch→main merge,
  // resolve conflicts accept-mine/accept-theirs per file, abort, or complete
  // (commit + push). One merge in flight per repository.
  merge: {
    start: (request: MergeStartRequest): Promise<Result<MergeStartResponse>> =>
      inv(IPC_CHANNELS.merge.start, request),
    resolve: (request: MergeResolveRequest): Promise<Result<MergeResolveResponse>> =>
      inv(IPC_CHANNELS.merge.resolve, request),
    abort: (request: MergeAbortRequest): Promise<Result<MergeAbortResponse>> =>
      inv(IPC_CHANNELS.merge.abort, request),
    complete: (request: MergeCompleteRequest): Promise<Result<MergeCompleteResponse>> =>
      inv(IPC_CHANNELS.merge.complete, request),
  },
};

// The renderer's Window.electronAPI contract is derived from this object —
// src/types/global.d.ts imports this type, so the bridge is declared exactly
// once.
export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
