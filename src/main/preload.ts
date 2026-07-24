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
  WorkspaceTeardownResponse,
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
  ResolveUserNameRequest,
  ResolveUserNameResponse,
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

// Expose window control APIs
contextBridge.exposeInMainWorld('electronAPI', {
  config: {
    get: async (): Promise<Result<Config>> => {
      return ipcRenderer.invoke('config:get') as Promise<Result<Config>>;
    },
    set: async (update: Partial<Config>): Promise<Result<Config>> => {
      return ipcRenderer.invoke('config:set', update) as Promise<Result<Config>>;
    },
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
    setExpanded: async (expanded: boolean): Promise<{ anchor: 'bottom' | 'top' }> => {
      return ipcRenderer.invoke('window:setExpanded', expanded) as Promise<{
        anchor: 'bottom' | 'top';
      }>;
    },
    openTerminal: async (path: string): Promise<VoidResult> => {
      return ipcRenderer.invoke('window:open-terminal', path) as Promise<VoidResult>;
    },
  },
  repository: {
    // includeProvisioned surfaces every registry origin (provisioned
    // worktrees included); omitted keeps the default card-view-only list.
    list: async (includeProvisioned?: boolean): Promise<Result<Repository[]>> => {
      return ipcRenderer.invoke('repository:list', includeProvisioned) as Promise<
        Result<Repository[]>
      >;
    },
    create: async (input: RepositoryCreateInput): Promise<Result<Repository>> => {
      return ipcRenderer.invoke('repository:create', input) as Promise<Result<Repository>>;
    },
    update: async (input: RepositoryUpdateInput): Promise<Result<Repository>> => {
      return ipcRenderer.invoke('repository:update', input) as Promise<Result<Repository>>;
    },
    delete: async (id: string): Promise<VoidResult> => {
      return ipcRenderer.invoke('repository:delete', id) as Promise<VoidResult>;
    },
    selectDirectory: async (): Promise<Result<string | null>> => {
      return ipcRenderer.invoke('repository:select-directory') as Promise<Result<string | null>>;
    },
    openInExplorer: async (path: string): Promise<VoidResult> => {
      return ipcRenderer.invoke('repository:open-in-explorer', path) as Promise<VoidResult>;
    },
  },
  lore: {
    branchInfo: async (
      repositoryPath: string,
      branch: string
    ): Promise<Result<BranchDivergence>> => {
      return ipcRenderer.invoke('lore:branchInfo', { repositoryPath, branch }) as Promise<
        Result<BranchDivergence>
      >;
    },
    branchGraph: async (repositoryPath: string, branch: string): Promise<Result<BranchGraph>> => {
      return ipcRenderer.invoke('lore:branchGraph', { repositoryPath, branch }) as Promise<
        Result<BranchGraph>
      >;
    },
    currentRevision: async (repositoryPath: string): Promise<Result<string>> => {
      return ipcRenderer.invoke('lore:currentRevision', repositoryPath) as Promise<Result<string>>;
    },
    repository: {
      listBranches: async (repositoryPath: string): Promise<Result<LoreBranch[]>> => {
        return ipcRenderer.invoke('lore:branches:list', repositoryPath) as Promise<
          Result<LoreBranch[]>
        >;
      },
      listRemoteRepositories: async (
        serverAddress: string
      ): Promise<Result<{ name: string; url: string }[]>> => {
        return ipcRenderer.invoke('lore:repository:list-remote', serverAddress) as Promise<
          Result<{ name: string; url: string }[]>
        >;
      },
      checkStatus: async (localPath: string): Promise<Result<LoreRepositoryStatus>> => {
        return ipcRenderer.invoke('lore:repository:status', localPath) as Promise<
          Result<LoreRepositoryStatus>
        >;
      },
      clone: async (repositoryUrl: string, localPath: string): Promise<VoidResult> => {
        return ipcRenderer.invoke(
          'lore:repository:clone',
          repositoryUrl,
          localPath
        ) as Promise<VoidResult>;
      },
      // One-way push channel from main streaming clone progress.
      onCloneProgress: makePushSubscription('lore:repository:clone-progress'),
      sync: async (
        repositoryPath: string,
        targetBranch?: string,
        options?: LoreSyncOptions
      ): Promise<VoidResult> => {
        return ipcRenderer.invoke(
          'lore:repository:sync',
          repositoryPath,
          targetBranch,
          options
        ) as Promise<VoidResult>;
      },
      commit: async (repositoryPath: string, message: string): Promise<VoidResult> => {
        return ipcRenderer.invoke(
          'lore:repository:commit',
          repositoryPath,
          message
        ) as Promise<VoidResult>;
      },
      push: async (repositoryPath: string): Promise<VoidResult> => {
        return ipcRenderer.invoke('lore:repository:push', repositoryPath) as Promise<VoidResult>;
      },
    },
    notifications: {
      subscribe: async (repositoryPath: string): Promise<VoidResult> => {
        return ipcRenderer.invoke(
          'lore:notifications:subscribe',
          repositoryPath
        ) as Promise<VoidResult>;
      },
      unsubscribe: async (repositoryPath: string): Promise<VoidResult> => {
        return ipcRenderer.invoke(
          'lore:notifications:unsubscribe',
          repositoryPath
        ) as Promise<VoidResult>;
      },
      // One-way push channel from main.
      onNotification: makePushSubscription('lore:notification'),
    },
    files: {
      getStatus: async (repositoryPath: string): Promise<Result<LoreFileStatusGroup>> => {
        return ipcRenderer.invoke('lore:files:status', repositoryPath) as Promise<
          Result<LoreFileStatusGroup>
        >;
      },
      // Stage/unstage take repo-relative file paths (as reported by
      // getStatus); the main process joins them against repositoryPath.
      stage: async (repositoryPath: string, filePaths: string[]): Promise<VoidResult> => {
        return ipcRenderer.invoke(
          'lore:files:stage',
          repositoryPath,
          filePaths
        ) as Promise<VoidResult>;
      },
      unstage: async (repositoryPath: string, filePaths: string[]): Promise<VoidResult> => {
        return ipcRenderer.invoke(
          'lore:files:unstage',
          repositoryPath,
          filePaths
        ) as Promise<VoidResult>;
      },
    },
  },
  path: {
    join: async (segments: string[]): Promise<Result<string>> => {
      return ipcRenderer.invoke('path:join', { segments }) as Promise<Result<string>>;
    },
    basename: async (path: string): Promise<Result<string>> => {
      return ipcRenderer.invoke('path:basename', { path }) as Promise<Result<string>>;
    },
  },
  // Workspace lifecycle (Mission Control, design 2a). Teardown is destructive
  // and double-guarded in the main process; the renderer confirms first.
  workspace: {
    provision: async (
      request: WorkspaceProvisionRequest
    ): Promise<Result<WorkspaceProvisionResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.workspace.provision, request) as Promise<
        Result<WorkspaceProvisionResponse>
      >;
    },
    teardown: async (
      request: WorkspaceTeardownRequest
    ): Promise<Result<WorkspaceTeardownResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.workspace.teardown, request) as Promise<
        Result<WorkspaceTeardownResponse>
      >;
    },
    // Manual idle → awaiting-review transition (design 2a "mark active");
    // owned by the workspace model in the main process.
    markActive: async (
      request: WorkspaceMarkActiveRequest
    ): Promise<Result<WorkspaceMarkActiveResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.workspace.markActive, request) as Promise<
        Result<WorkspaceMarkActiveResponse>
      >;
    },
    // Untrack-only removal (design amendment): drops the workspace from the
    // registry without touching the worktree directory or the branch.
    forget: async (request: WorkspaceForgetRequest): Promise<VoidResult> => {
      return ipcRenderer.invoke(IPC_CHANNELS.workspace.forget, request) as Promise<VoidResult>;
    },
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
    watch: async (repositoryId: string): Promise<Result<WorkspaceModelSnapshot>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.workspaceModel.watch, repositoryId) as Promise<
        Result<WorkspaceModelSnapshot>
      >;
    },
    refresh: async (repositoryId: string): Promise<VoidResult> => {
      return ipcRenderer.invoke(
        IPC_CHANNELS.workspaceModel.refresh,
        repositoryId
      ) as Promise<VoidResult>;
    },
    onSnapshot: makePushSubscription(IPC_CHANNELS.workspaceModel.snapshot),
  },
  // The review window's compare picker (design 2b).
  diff: {
    compare: async (request: DiffRequest): Promise<Result<DiffResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.diff.compare, request) as Promise<
        Result<DiffResponse>
      >;
    },
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
    requestContext: async (): Promise<Result<ReviewOpenRequest>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.review.requestContext) as Promise<
        Result<ReviewOpenRequest>
      >;
    },
    onContext: makePushSubscription(IPC_CHANNELS.review.context),
  },
  // The review window's merge workflow (design 2c): start a branch→main merge,
  // resolve conflicts accept-mine/accept-theirs per file, abort, or complete
  // (commit + push). One merge in flight per repository.
  merge: {
    start: async (request: MergeStartRequest): Promise<Result<MergeStartResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.merge.start, request) as Promise<
        Result<MergeStartResponse>
      >;
    },
    resolve: async (request: MergeResolveRequest): Promise<Result<MergeResolveResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.merge.resolve, request) as Promise<
        Result<MergeResolveResponse>
      >;
    },
    abort: async (request: MergeAbortRequest): Promise<Result<MergeAbortResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.merge.abort, request) as Promise<
        Result<MergeAbortResponse>
      >;
    },
    complete: async (request: MergeCompleteRequest): Promise<Result<MergeCompleteResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.merge.complete, request) as Promise<
        Result<MergeCompleteResponse>
      >;
    },
  },
  // Attribution name resolution (P5's resolveUserName), exposed for the P15
  // toast.
  identity: {
    resolveUserName: async (
      request: ResolveUserNameRequest
    ): Promise<Result<ResolveUserNameResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.identity.resolveUserName, request) as Promise<
        Result<ResolveUserNameResponse>
      >;
    },
  },
});
