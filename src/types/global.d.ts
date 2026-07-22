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
  ReviewOpenRequest,
  WorkspaceModelSnapshot,
  LockQueryRequest,
  LockQueryResponse,
  LockReleaseRequest,
  LockReleaseResponse,
  ResolveUserNameRequest,
  ResolveUserNameResponse,
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
        markActive: (
          request: WorkspaceMarkActiveRequest
        ) => Promise<Result<WorkspaceMarkActiveResponse>>;
      };
      agent: {
        // Registers a listener for agent session-state updates pushed from
        // main; returns the cleanup that removes it. Payloads are validated in
        // the renderer.
        onObservability: (callback: (push: unknown) => void) => () => void;
      };
      diff: {
        compare: (request: DiffRequest) => Promise<Result<DiffResponse>>;
      };
      // Review window (P11, design 2b/2c). open sends the open request to
      // main; requestContext pulls the current window's request on mount;
      // onContext subscribes to re-targets (payloads validated in the
      // renderer).
      review: {
        open: (request: ReviewOpenRequest) => void;
        requestContext: () => Promise<Result<ReviewOpenRequest>>;
        onContext: (callback: (request: unknown) => void) => () => void;
      };
      // The review window's merge workflow (design 2c, P13).
      merge: {
        start: (request: MergeStartRequest) => Promise<Result<MergeStartResponse>>;
        resolve: (request: MergeResolveRequest) => Promise<Result<MergeResolveResponse>>;
        abort: (request: MergeAbortRequest) => Promise<Result<MergeAbortResponse>>;
        complete: (request: MergeCompleteRequest) => Promise<Result<MergeCompleteResponse>>;
      };
      // Mission Control window (design 2a). open/close manage the secondary
      // window; watch targets the workspace model at a repo and returns its
      // snapshot; refresh triggers an immediate rebuild on demand (the
      // header's manual refresh control); onSnapshot subscribes to
      // subsequent rebuilds (payloads validated in the renderer).
      missionControl: {
        open: (repositoryId?: string) => void;
        close: () => void;
        watch: (repositoryId: string) => Promise<Result<WorkspaceModelSnapshot>>;
        refresh: (repositoryId: string) => Promise<VoidResult>;
        onSnapshot: (callback: (snapshot: unknown) => void) => () => void;
      };
      locks: {
        query: (request: LockQueryRequest) => Promise<Result<LockQueryResponse>>;
        release: (request: LockReleaseRequest) => Promise<Result<LockReleaseResponse>>;
      };
      // Attribution name resolution (P5's resolveUserName), exposed for the
      // P15 toast.
      identity: {
        resolveUserName: (
          request: ResolveUserNameRequest
        ) => Promise<Result<ResolveUserNameResponse>>;
      };
    };
  }
}
