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
  ReviewOpenRequest,
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
          // Resolves the committed revision hash.
          commit: (repositoryPath: string, message: string) => Promise<Result<string>>;
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
      // The review window's compare picker.
      diff: {
        compare: (request: DiffRequest) => Promise<Result<DiffResponse>>;
      };
      // Review window: open/re-target the per-repository secondary window,
      // pull the open request on mount, subscribe to re-targets. Push
      // payloads are validated in the renderer.
      review: {
        open: (request: ReviewOpenRequest) => void;
        requestContext: () => Promise<Result<ReviewOpenRequest>>;
        onContext: (callback: (request: unknown) => void) => () => void;
      };
      // The review window's merge workflow; one merge in flight per
      // repository.
      merge: {
        start: (request: MergeStartRequest) => Promise<Result<MergeStartResponse>>;
        resolve: (request: MergeResolveRequest) => Promise<Result<MergeResolveResponse>>;
        abort: (request: MergeAbortRequest) => Promise<Result<MergeAbortResponse>>;
        complete: (request: MergeCompleteRequest) => Promise<Result<MergeCompleteResponse>>;
      };
    };
  }
}
