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
  WorkspaceListRequest,
  WorkspaceListResponse,
  WorkspaceTeardownRequest,
  WorkspaceTeardownResponse,
  WorkspaceMarkActiveRequest,
  WorkspaceMarkActiveResponse,
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
  WorkspaceModelSnapshot,
  LockQueryRequest,
  LockQueryResponse,
  LockReleaseRequest,
  LockReleaseResponse,
} from '../shared/types';

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
    list: async (): Promise<Result<Repository[]>> => {
      return ipcRenderer.invoke('repository:list') as Promise<Result<Repository[]>>;
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
      // One-way push channel from main streaming clone progress; the
      // payload crosses the bridge as unknown and is Zod-validated in the
      // renderer before use.
      onCloneProgress: (callback: (progress: unknown) => void): (() => void) => {
        const listener = (_event: unknown, payload: unknown): void => {
          callback(payload);
        };
        ipcRenderer.on('lore:repository:clone-progress', listener);
        return (): void => {
          ipcRenderer.removeListener('lore:repository:clone-progress', listener);
        };
      },
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
      // One-way push channel from main; the payload crosses the bridge as
      // unknown and is Zod-validated in the renderer before use.
      onNotification: (callback: (notification: unknown) => void): (() => void) => {
        const listener = (_event: unknown, payload: unknown): void => {
          callback(payload);
        };
        ipcRenderer.on('lore:notification', listener);
        return (): void => {
          ipcRenderer.removeListener('lore:notification', listener);
        };
      },
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
    list: async (request: WorkspaceListRequest): Promise<Result<WorkspaceListResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.workspace.list, request) as Promise<
        Result<WorkspaceListResponse>
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
  },
  // Mission Control window (P10, design 2a). `open`/`close` manage the
  // secondary window; `watch` points the workspace model at a repository and
  // returns its current snapshot; `onSnapshot` subscribes to subsequent model
  // rebuilds (payload crosses the bridge as unknown, Zod-validated in the
  // renderer before use).
  missionControl: {
    open: (repositoryId?: string): void => {
      ipcRenderer.send(IPC_CHANNELS.missionControl.open, repositoryId);
    },
    close: (): void => {
      ipcRenderer.send(IPC_CHANNELS.missionControl.close);
    },
    watch: async (repositoryId: string): Promise<Result<WorkspaceModelSnapshot>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.workspaceModel.watch, repositoryId) as Promise<
        Result<WorkspaceModelSnapshot>
      >;
    },
    onSnapshot: (callback: (snapshot: unknown) => void): (() => void) => {
      const listener = (_event: unknown, payload: unknown): void => {
        callback(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.workspaceModel.snapshot, listener);
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.workspaceModel.snapshot, listener);
      };
    },
  },
  // The review window's compare picker (design 2b).
  diff: {
    compare: async (request: DiffRequest): Promise<Result<DiffResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.diff.compare, request) as Promise<
        Result<DiffResponse>
      >;
    },
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
  // Agent observability (research note): session-state updates pushed from the
  // main-process hook listener.
  agent: {
    // One-way push channel from main; the payload crosses the bridge as
    // unknown and is Zod-validated in the renderer before use.
    onObservability: (callback: (push: unknown) => void): (() => void) => {
      const listener = (_event: unknown, payload: unknown): void => {
        callback(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.agent.observability, listener);
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.agent.observability, listener);
      };
    },
  },
  // Lock visibility (spec "Supporting signals"): show + release, never
  // enforce acquisition.
  locks: {
    query: async (request: LockQueryRequest): Promise<Result<LockQueryResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.locks.query, request) as Promise<
        Result<LockQueryResponse>
      >;
    },
    release: async (request: LockReleaseRequest): Promise<Result<LockReleaseResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.locks.release, request) as Promise<
        Result<LockReleaseResponse>
      >;
    },
  },
});
