import { contextBridge, ipcRenderer } from 'electron';
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
  Result,
  VoidResult,
} from '../shared/types';
import { IPC_CHANNELS } from '../shared/schemas';

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
    // The card <-> Project View morph: main resizes the window between the
    // card and review footprints (and toggles always-on-top) while the
    // renderer crossfades the surfaces.
    setView: async (view: 'card' | 'projectView'): Promise<void> => {
      await ipcRenderer.invoke('window:setView', view);
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
    // The card's merge-entry gate: whether sourceBranch carries revisions
    // targetBranch lacks (false once landed, even by another client).
    revisionsToLand: async (request: {
      repositoryPath: string;
      sourceBranch: string;
      targetBranch: string;
    }): Promise<Result<boolean>> => {
      return ipcRenderer.invoke('lore:revisionsToLand', request) as Promise<Result<boolean>>;
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
      // Resolves the committed revision hash.
      commit: async (repositoryPath: string, message: string): Promise<Result<string>> => {
        return ipcRenderer.invoke('lore:repository:commit', repositoryPath, message) as Promise<
          Result<string>
        >;
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
  // The Project View's compare picker.
  diff: {
    compare: async (request: DiffRequest): Promise<Result<DiffResponse>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.diff.compare, request) as Promise<
        Result<DiffResponse>
      >;
    },
  },
  // The Project View's merge workflow: start a branch→target merge, resolve
  // conflicts accept-mine/accept-theirs per file, abort, or complete
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
});
