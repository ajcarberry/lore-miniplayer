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
  DiffRequest,
  DiffResponse,
} from '../shared/types';

declare global {
  interface Window {
    electronAPI: {
      config: {
        get: () => Promise<Result<Config>>;
        set: (update: Partial<Config>) => Promise<Result<Config>>;
      };
      window: {
        minimize: () => void;
        close: () => void;
        move: (x: number, y: number) => void;
        // One-way: while active, main keeps the window fully opaque even
        // when unfocused so the pill's notice pulse stays visible.
        setNoticeActive: (active: boolean) => void;
        setExpanded: (expanded: boolean) => Promise<{ anchor: 'bottom' | 'top' }>;
        openTerminal: (path: string) => Promise<VoidResult>;
      };
      repository: {
        list: () => Promise<Result<Repository[]>>;
        create: (input: RepositoryCreateInput) => Promise<Result<Repository>>;
        update: (input: RepositoryUpdateInput) => Promise<Result<Repository>>;
        delete: (id: string) => Promise<VoidResult>;
        selectDirectory: () => Promise<Result<string | null>>;
        openInExplorer: (path: string) => Promise<VoidResult>;
      };
      lore: {
        branchInfo: (repositoryPath: string, branch: string) => Promise<Result<BranchDivergence>>;
        branchGraph: (repositoryPath: string, branch: string) => Promise<Result<BranchGraph>>;
        currentRevision: (repositoryPath: string) => Promise<Result<string>>;
        repository: {
          listBranches: (repositoryPath: string) => Promise<Result<LoreBranch[]>>;
          listRemoteRepositories: (
            serverAddress: string
          ) => Promise<Result<{ name: string; url: string }[]>>;
          checkStatus: (localPath: string) => Promise<Result<LoreRepositoryStatus>>;
          clone: (repositoryUrl: string, localPath: string) => Promise<VoidResult>;
          // Registers a listener for clone progress pushed from main;
          // returns the cleanup that removes it. Payloads are validated in
          // the renderer.
          onCloneProgress: (callback: (progress: unknown) => void) => () => void;
          sync: (
            repositoryPath: string,
            targetBranch?: string,
            options?: LoreSyncOptions
          ) => Promise<VoidResult>;
          commit: (repositoryPath: string, message: string) => Promise<VoidResult>;
          push: (repositoryPath: string) => Promise<VoidResult>;
        };
        files: {
          getStatus: (repositoryPath: string) => Promise<Result<LoreFileStatusGroup>>;
          // Stage/unstage take repo-relative paths; joined in main.
          stage: (repositoryPath: string, filePaths: string[]) => Promise<VoidResult>;
          unstage: (repositoryPath: string, filePaths: string[]) => Promise<VoidResult>;
        };
        notifications: {
          subscribe: (repositoryPath: string) => Promise<VoidResult>;
          unsubscribe: (repositoryPath: string) => Promise<VoidResult>;
          // Registers a listener for server push notifications; returns the
          // cleanup that removes it. Payloads are validated in the renderer.
          onNotification: (callback: (notification: unknown) => void) => () => void;
        };
      };
      path: {
        join: (segments: string[]) => Promise<Result<string>>;
        basename: (path: string) => Promise<Result<string>>;
      };
      workspace: {
        provision: (
          request: WorkspaceProvisionRequest
        ) => Promise<Result<WorkspaceProvisionResponse>>;
        list: (request: WorkspaceListRequest) => Promise<Result<WorkspaceListResponse>>;
        teardown: (request: WorkspaceTeardownRequest) => Promise<Result<WorkspaceTeardownResponse>>;
      };
      diff: {
        compare: (request: DiffRequest) => Promise<Result<DiffResponse>>;
      };
    };
  }
}
