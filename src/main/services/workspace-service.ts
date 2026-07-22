import { lore, LoreError } from '@lore-vcs/sdk';
import type { LoreFluentApi } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MainLogger } from '../ipc/logger';
import type { RepositoryService } from './repository';
import type { LoreRepositoryService } from './lore-repository';
import { collectEvents } from './lore-events';
import type { LoreEventDataOf } from './lore-events';
import { WorkspaceStore } from './workspace-store';
import type { WorkspaceRegistryEntry } from './workspace-store';
import { writeObserverHooks } from './workspace-hooks';
import type { WorkspaceObserverConfig } from './workspace-hooks';
import type {
  Repository,
  Workspace,
  WorkspaceProvisionRequest,
  WorkspaceTeardownRequest,
  WorkspaceTeardownResult,
} from '../../shared/types';
import {
  WorkspaceProvisionRequestSchema,
  WorkspaceTeardownRequestSchema,
  WorkspaceSchema,
} from '../../shared/schemas';

// Worktree directories are placed as a sibling of the repository's own
// checkout, under `<repoName>-wt/<branch>` (design 2a). The suffix keeps the
// worktree root visibly adjacent to, and distinct from, the repo directory.
const WORKTREE_DIR_SUFFIX = '-wt';

// Fallback loopback port used for the observer hook URL until P7's listener
// wires a real one through `setObserverConfig`. The hooks are fire-and-forget
// POSTs, so a not-yet-listening port is harmless.
const DEFAULT_OBSERVER_PORT = 41_500;

// Re-exported so existing importers (agent-observer) keep their import site.
export type { WorkspaceObserverConfig } from './workspace-hooks';

export class WorkspaceOperationError extends Error {
  constructor(
    message: string,
    public readonly errorType?: number
  ) {
    super(message);
    this.name = 'WorkspaceOperationError';
  }
}

interface RawInstance {
  instanceId: string;
  path: string;
  branchName: string;
  branch: string;
  revision: string;
  stale: boolean;
}

// Provisions, lists, and tears down agent workspaces ("worktrees"): a branch
// checked out in a new directory backed by Lore's shared store, with Claude
// Code observer hooks injected. Teardown is destructive and double-guarded
// (see teardown). SDK connectivity for the clone is a hard dependency (P1
// finding b: clone contacts the repo's real server); the shape here follows
// the documented-best path and is exercised through mocks, with the
// live-server flow integration-pending.
export class WorkspaceService {
  private observerConfig: WorkspaceObserverConfig;

  // App-side persistent registry of provisioned workspaces (workspaces.json).
  // The source of truth for WHICH workspaces exist: Lore's instance registry is
  // PER-STORE, so the repository's primary checkout cannot see its shared-store
  // worktrees (P18 live finding). Live fields are enriched from each
  // workspace's OWN path at read time.
  private readonly store: WorkspaceStore;

  constructor(
    private readonly log: MainLogger,
    private readonly repositoryService: RepositoryService,
    private readonly loreRepositoryService: LoreRepositoryService,
    observerConfig?: WorkspaceObserverConfig
  ) {
    this.store = new WorkspaceStore(log);
    this.observerConfig = observerConfig ?? {
      port: DEFAULT_OBSERVER_PORT,
      tokenForWorkspace: (): string => randomUUID(),
    };
  }

  // Lets P7 (the hook listener) inject the real port + token provider once it
  // owns them, without reworking provisioning.
  setObserverConfig(config: WorkspaceObserverConfig): void {
    this.observerConfig = config;
  }

  // Provision a workspace: shared-store clone of the repo's server URL into a
  // sibling worktree directory, create + switch to the new branch, inject
  // observer hooks, and return the tracked instance record. A clone failure
  // mid-flight cleans up the partial directory and never leaves an orphan.
  async provision(request: WorkspaceProvisionRequest): Promise<Workspace> {
    const { repositoryId, branchName } = WorkspaceProvisionRequestSchema.parse(request);

    const repo = await this.repositoryService.getById(repositoryId);
    if (!repo) {
      throw new Error(`Repository with id "${repositoryId}" not found`);
    }

    const worktreeRoot = this.worktreeRootFor(repo.localPath);
    const workspacePath = path.join(worktreeRoot, branchName);
    this.assertWithinRoot(workspacePath, worktreeRoot);

    if (await this.pathExists(workspacePath)) {
      // Adoption (P18): a directory that already exists AND self-reports a
      // matching-branch instance is an orphaned workspace (e.g. provisioned by
      // the pre-fix flow that never persisted a registry entry). Heal it into
      // the registry instead of failing outright.
      const adopted = await this.adoptExisting(workspacePath, branchName, repo.id);
      if (adopted) {
        return adopted;
      }
      throw new Error(`Workspace directory already exists: ${workspacePath}`);
    }

    await fs.mkdir(path.dirname(workspacePath), { recursive: true });

    try {
      await this.run(
        lore.repositoryClone(
          { repositoryPath: workspacePath },
          { repositoryUrl: repo.url, useSharedStore: true, sharedStorePath: '' }
        ),
        `Failed to clone workspace for repository "${repo.name}"`
      );
      await this.run(
        lore.branchCreate({ repositoryPath: workspacePath }, { branch: branchName }),
        `Failed to create branch "${branchName}"`
      );
      await this.loreRepositoryService.switchBranch(workspacePath, branchName);
    } catch (error) {
      // No orphan registration: clean up whatever the partial clone left.
      await this.safeRemoveDir(workspacePath);
      throw error;
    }

    await this.writeObserverHooks(workspacePath);

    // Verify against the workspace's OWN store (self-report) — the shared store
    // the clone joined lists this member. The primary checkout's private store
    // never would (P18 live finding).
    const match = await this.selfInstance(workspacePath);
    if (!match) {
      throw new WorkspaceOperationError(
        `Provisioned workspace was not registered as an instance: ${workspacePath}`
      );
    }

    // Registry entry is written only after verification succeeds.
    const provisionedAt = new Date().toISOString();
    await this.store.add({
      repositoryId: repo.id,
      path: workspacePath,
      branchName,
      provisionedAt,
    });
    return this.toWorkspace(match, repo.id, provisionedAt);
  }

  // List the repository's provisioned workspaces. The persistent registry is
  // the source of truth for WHICH workspaces exist (P18: the primary checkout's
  // per-store registry cannot see shared-store worktrees). Each entry is
  // enriched from its OWN path (branch/revision/stale via self-report); a
  // missing directory or a failed query yields a stale row rather than throwing,
  // so Mission Control still shows it.
  async list(repositoryId: string): Promise<Workspace[]> {
    const repo = await this.repositoryService.getById(repositoryId);
    if (!repo) {
      throw new Error(`Repository with id "${repositoryId}" not found`);
    }
    const entries = await this.store.listByRepository(repo.id);
    const workspaces: Workspace[] = [];
    for (const entry of entries) {
      const instance = await this.enrichEntry(entry);
      workspaces.push(
        instance
          ? this.toWorkspace(instance, repo.id, entry.provisionedAt)
          : this.staleWorkspace(entry, repo.id)
      );
    }
    return workspaces;
  }

  // Tear a workspace down — destructive (removes the worktree directory and
  // archives the local branch). Guards, in order: the target must be a
  // tracked instance of a known repo (verified via the instance registry
  // before any disk touch); it may not be the repo's own checkout or a
  // symlink escaping the workspace root; and, unless `force`, it must have no
  // uncommitted or unpushed work. Every step is logged. Remote-branch removal
  // has no offline/SDK path (P1 finding d) — it is a recorded server ask,
  // reported as remoteBranchRemoved:false.
  async teardown(request: WorkspaceTeardownRequest): Promise<WorkspaceTeardownResult> {
    const parsed = WorkspaceTeardownRequestSchema.parse(request);

    const located = await this.locateWorkspace(parsed);
    if (!located) {
      throw new Error('Workspace not found or not a tracked instance');
    }
    const { repo, entry, instance } = located;
    // The registry is the source of truth for the path; the branch name comes
    // from the registry too, so a missing/stale live instance can't strand it.
    const workspacePath = entry.path;
    const branchName = entry.branchName;

    await this.assertSafeTeardownPath(workspacePath, repo.localPath);

    if (!parsed.force) {
      await this.assertNoUnsavedWork(workspacePath, branchName);
    }

    this.log.info('Workspace teardown: removing directory', {
      operation: 'workspace:teardown',
      workspacePath,
    });
    await fs.rm(workspacePath, { recursive: true, force: true });
    await this.store.remove(workspacePath);

    // Prune + archive act on the SHARED store, not the primary checkout's
    // private store (P18). Both require a live handle into that store, so they
    // run against ANOTHER registered workspace of the same repo (a sibling that
    // shares the store). Tearing down the last one leaves a harmless orphan
    // record in the now-unreferenced store — skip with a log line.
    const sibling = await this.siblingWorkspacePath(repo.id, workspacePath);

    let localBranchRemoved = false;
    if (sibling) {
      try {
        await this.run(
          lore.repositoryInstancePrune({ repositoryPath: sibling }, {}),
          'Failed to prune workspace instance'
        );
      } catch (error) {
        this.log.error('Workspace teardown: failed to prune instance (continuing)', {
          error,
          operation: 'workspace:teardown',
          workspacePath,
        });
      }
      try {
        await this.run(
          lore.branchArchive({ repositoryPath: sibling }, { branch: branchName }),
          'Failed to archive local branch'
        );
        localBranchRemoved = true;
      } catch (error) {
        this.log.error('Workspace teardown: failed to archive local branch (continuing)', {
          error,
          operation: 'workspace:teardown',
          branch: branchName,
        });
      }
    } else {
      this.log.info(
        'Workspace teardown: no sibling workspace in the shared store; skipping prune + archive',
        { operation: 'workspace:teardown', workspacePath, branch: branchName }
      );
    }

    return {
      workspaceId: instance?.instanceId ?? workspacePath,
      path: workspacePath,
      directoryRemoved: true,
      localBranchRemoved,
      // Remote-branch removal is a server ask, not implemented (P1 finding d).
      remoteBranchRemoved: false,
    };
  }

  // Write Claude Code observer hooks into the workspace's settings.local.json.
  // Public so P7 can re-inject if it rotates tokens; the writer itself lives in
  // ./workspace-hooks.
  async writeObserverHooks(workspacePath: string): Promise<void> {
    await writeObserverHooks(this.log, workspacePath, this.observerConfig);
  }

  // --- internals ------------------------------------------------------------

  private worktreeRootFor(repoLocalPath: string): string {
    const parent = path.dirname(repoLocalPath);
    const repoName = path.basename(repoLocalPath);
    return path.join(parent, `${repoName}${WORKTREE_DIR_SUFFIX}`);
  }

  private assertWithinRoot(target: string, root: string): void {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget === resolvedRoot) {
      throw new Error(
        'Invalid branch name: workspace path must be a subdirectory of the worktree root'
      );
    }
    if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Resolved workspace path escapes the worktree root: ${resolvedTarget}`);
    }
  }

  private async assertSafeTeardownPath(
    workspacePath: string,
    repoLocalPath: string
  ): Promise<void> {
    const resolved = path.resolve(workspacePath);
    if (resolved === path.resolve(repoLocalPath)) {
      throw new Error('Refusing to remove the repository checkout itself');
    }
    const stats = await fs.lstat(resolved).catch(() => null);
    if (stats?.isSymbolicLink()) {
      throw new Error('Refusing to remove a symlinked workspace path');
    }
  }

  private async assertNoUnsavedWork(workspacePath: string, branchName: string): Promise<void> {
    const status = await this.loreRepositoryService.getFileStatus(workspacePath);
    const dirtyCount = status.untracked.length + status.unstaged.length + status.staged.length;
    if (dirtyCount > 0) {
      throw new Error('Workspace has uncommitted changes; pass force to remove it anyway');
    }
    const divergence = await this.loreRepositoryService.getBranchDivergence(
      workspacePath,
      branchName
    );
    if (divergence.state === 'ahead') {
      throw new Error('Workspace has unpushed commits; pass force to remove it anyway');
    }
  }

  // Adopt an already-on-disk workspace into the registry when it self-reports a
  // matching-branch instance. Returns the adopted Workspace, or undefined when
  // the directory is not a matching workspace (so the caller can refuse).
  private async adoptExisting(
    workspacePath: string,
    branchName: string,
    repositoryId: string
  ): Promise<Workspace | undefined> {
    const match = await this.selfInstance(workspacePath);
    if (!match || match.branchName !== branchName) {
      return undefined;
    }
    const existing = await this.store.findByPath(workspacePath);
    const provisionedAt = existing?.provisionedAt ?? new Date().toISOString();
    await this.store.add({ repositoryId, path: workspacePath, branchName, provisionedAt });
    this.log.info('Adopted an existing workspace into the registry', {
      operation: 'workspace:provision',
      workspacePath,
      branch: branchName,
    });
    return this.toWorkspace(match, repositoryId, provisionedAt);
  }

  // Resolve a teardown request to its registry entry (the source of truth),
  // enriched with the live instance where available. A `workspaceId` matches
  // either the live instance id or the synthetic id used for stale rows (the
  // path); a `path` matches the registry entry directly.
  private async locateWorkspace(
    parsed: WorkspaceTeardownRequest
  ): Promise<{ repo: Repository; entry: WorkspaceRegistryEntry; instance?: RawInstance } | null> {
    const entries = await this.store.list();
    for (const entry of entries) {
      const repo = await this.repositoryService.getById(entry.repositoryId);
      if (!repo) {
        continue;
      }
      const instance = await this.enrichEntry(entry);
      const matches =
        'workspaceId' in parsed
          ? instance?.instanceId === parsed.workspaceId ||
            this.samePath(entry.path, parsed.workspaceId)
          : this.samePath(entry.path, parsed.path);
      if (matches) {
        return instance ? { repo, entry, instance } : { repo, entry };
      }
    }
    return null;
  }

  // The live instance a workspace path self-reports for its own directory (its
  // shared store lists it). Undefined when the directory is gone or the query
  // fails — never throws (P18 enrichment contract).
  private async enrichEntry(entry: WorkspaceRegistryEntry): Promise<RawInstance | undefined> {
    if (!(await this.pathExists(entry.path))) {
      return undefined;
    }
    return this.selfInstance(entry.path);
  }

  private async selfInstance(workspacePath: string): Promise<RawInstance | undefined> {
    try {
      const instances = await this.listInstances(workspacePath);
      return instances.find(inst => this.samePath(inst.path, workspacePath));
    } catch (error) {
      this.log.error('Failed to self-report workspace instance (treating as stale)', {
        error,
        operation: 'workspace:enrich',
        workspacePath,
      });
      return undefined;
    }
  }

  // Another registered workspace of the same repo (sharing the same Lore store),
  // excluding the one being torn down. Prune/archive run against it.
  private async siblingWorkspacePath(
    repositoryId: string,
    excludePath: string
  ): Promise<string | undefined> {
    const entries = await this.store.listByRepository(repositoryId);
    const sibling = entries.find(entry => !this.samePath(entry.path, excludePath));
    return sibling?.path;
  }

  // A stale Mission Control row for a registered workspace whose directory is
  // gone or whose store cannot be queried. The path doubles as a stable
  // synthetic instance id (the live id is unknown).
  private staleWorkspace(entry: WorkspaceRegistryEntry, repositoryId: string): Workspace {
    return WorkspaceSchema.parse({
      instanceId: entry.path,
      path: entry.path,
      branchName: entry.branchName,
      revision: '',
      stale: true,
      repositoryId,
      provisionedAt: entry.provisionedAt,
    });
  }

  private async listInstances(repositoryPath: string): Promise<RawInstance[]> {
    return this.collect(
      lore.repositoryInstanceList({ repositoryPath }, {}),
      LoreEventTag.REPOSITORY_INSTANCE,
      (data: LoreEventDataOf<LoreEventTag.REPOSITORY_INSTANCE>) => ({
        instanceId: String(data.instanceId),
        path: String(data.path),
        branchName: String(data.branchName),
        branch: String(data.branch),
        revision: String(data.revision),
        stale: Boolean(data.stale),
      }),
      'Failed to list workspace instances'
    );
  }

  private toWorkspace(inst: RawInstance, repositoryId: string, provisionedAt?: string): Workspace {
    return WorkspaceSchema.parse({
      instanceId: inst.instanceId,
      path: inst.path,
      branchName: inst.branchName,
      revision: inst.revision,
      stale: inst.stale,
      repositoryId,
      ...(provisionedAt ? { provisionedAt } : {}),
    });
  }

  private samePath(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  private async safeRemoveDir(dir: string): Promise<void> {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      this.log.error('Failed to clean up partial workspace directory', {
        error,
        operation: 'workspace:provision',
        dir,
      });
    }
  }

  private async run(operation: LoreFluentApi, context: string): Promise<void> {
    try {
      await operation.waitAsync();
    } catch (error) {
      throw this.toOperationError(context, error);
    }
  }

  private async collect<TTag extends LoreEventTag, T>(
    operation: LoreFluentApi,
    tag: TTag,
    map: (data: LoreEventDataOf<TTag>) => T | undefined,
    context: string
  ): Promise<T[]> {
    return collectEvents(operation, tag, map, error => this.toOperationError(context, error));
  }

  private toOperationError(context: string, error: unknown): WorkspaceOperationError {
    if (error instanceof WorkspaceOperationError) {
      return error;
    }
    if (error instanceof LoreError) {
      const firstError = error.loreErrors?.[0];
      return new WorkspaceOperationError(
        `${context}: ${error.message}`,
        firstError?.data.errorType
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new WorkspaceOperationError(`${context}: ${message}`);
  }
}
