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

// Claude Code observer hooks are written to the workspace's *local* settings
// so the plumbing never pollutes the branch the agent commits (research note:
// settings.local.json is gitignored, picked up on first launch, no trust
// prompt).
const CLAUDE_SETTINGS_REL = path.join('.claude', 'settings.local.json');

// The hook events the observer cares about (research note "Recommended
// shape"): session lifecycle, the task prompt, the waiting-on-you signal,
// turn completion, and live tool activity.
const OBSERVER_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'PostToolUse',
] as const;

// Fallback loopback port used for the observer hook URL until P7's listener
// wires a real one through `setObserverConfig`. The hooks are fire-and-forget
// POSTs, so a not-yet-listening port is harmless.
const DEFAULT_OBSERVER_PORT = 41_500;

// The seam P7 (the hook listener) fills: the loopback port it listens on and
// a per-workspace token embedded in each hook URL for authentication.
export interface WorkspaceObserverConfig {
  readonly port: number;
  readonly tokenForWorkspace: (workspacePath: string) => string;
}

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

  // Provisioning timestamps by workspace path — enriches listings, which the
  // instance registry itself does not carry. In-memory only (the field is
  // optional; a restart simply drops it).
  private readonly provisionedAtByPath = new Map<string, string>();

  constructor(
    private readonly log: MainLogger,
    private readonly repositoryService: RepositoryService,
    private readonly loreRepositoryService: LoreRepositoryService,
    observerConfig?: WorkspaceObserverConfig
  ) {
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

    const provisionedAt = new Date().toISOString();
    this.provisionedAtByPath.set(workspacePath, provisionedAt);

    const instances = await this.listInstances(repo.localPath);
    const match = instances.find(inst => this.samePath(inst.path, workspacePath));
    if (!match) {
      throw new WorkspaceOperationError(
        `Provisioned workspace was not registered as an instance: ${workspacePath}`
      );
    }
    return this.toWorkspace(match, repo.id, provisionedAt);
  }

  // List the repository's provisioned workspaces — the instance registry is
  // the worktree list (P1 finding b). Stale instances are kept (surfaced in
  // Mission Control); the repository's own primary checkout is excluded.
  async list(repositoryId: string): Promise<Workspace[]> {
    const repo = await this.repositoryService.getById(repositoryId);
    if (!repo) {
      throw new Error(`Repository with id "${repositoryId}" not found`);
    }
    const instances = await this.listInstances(repo.localPath);
    return instances
      .filter(inst => !this.samePath(inst.path, repo.localPath))
      .map(inst => this.toWorkspace(inst, repo.id, this.provisionedAtByPath.get(inst.path)));
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
    const { repo, instance } = located;
    const workspacePath = instance.path;

    await this.assertSafeTeardownPath(workspacePath, repo.localPath);

    if (!parsed.force) {
      await this.assertNoUnsavedWork(workspacePath, instance.branchName);
    }

    this.log.info('Workspace teardown: removing directory', {
      operation: 'workspace:teardown',
      workspacePath,
    });
    await fs.rm(workspacePath, { recursive: true, force: true });

    let localBranchRemoved = false;
    try {
      await this.run(
        lore.repositoryInstancePrune({ repositoryPath: repo.localPath }, {}),
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
        lore.branchArchive({ repositoryPath: repo.localPath }, { branch: instance.branchName }),
        'Failed to archive local branch'
      );
      localBranchRemoved = true;
    } catch (error) {
      this.log.error('Workspace teardown: failed to archive local branch (continuing)', {
        error,
        operation: 'workspace:teardown',
        branch: instance.branchName,
      });
    }

    return {
      workspaceId: instance.instanceId,
      path: workspacePath,
      directoryRemoved: true,
      localBranchRemoved,
      // Remote-branch removal is a server ask, not implemented (P1 finding d).
      remoteBranchRemoved: false,
    };
  }

  // Write Claude Code observer hooks into the workspace's settings.local.json,
  // deep-merging into any existing file so user content is never clobbered.
  // Public so P7 can re-inject if it rotates tokens.
  async writeObserverHooks(workspacePath: string): Promise<void> {
    const settingsPath = path.join(workspacePath, CLAUDE_SETTINGS_REL);
    const token = this.observerConfig.tokenForWorkspace(workspacePath);
    const url = `http://127.0.0.1:${this.observerConfig.port}/hook/${token}`;
    const hookGroup = { hooks: [{ type: 'http', url }] };

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        // Unreadable/malformed existing file: never clobber it. Skip hook
        // injection and log — provisioning still succeeds, observability
        // degrades.
        this.log.error('Failed to read existing Claude settings; skipping observer hooks', {
          error,
          operation: 'workspace:writeObserverHooks',
          settingsPath,
        });
        return;
      }
    }

    const merged = this.mergeObserverHooks(existing, hookGroup);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  }

  // --- internals ------------------------------------------------------------

  private mergeObserverHooks(
    existing: Record<string, unknown>,
    hookGroup: { hooks: Array<{ type: string; url: string }> }
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...existing };
    const existingHooks = existing['hooks'];
    const hooks: Record<string, unknown> =
      existingHooks && typeof existingHooks === 'object' && !Array.isArray(existingHooks)
        ? { ...(existingHooks as Record<string, unknown>) }
        : {};

    for (const event of OBSERVER_HOOK_EVENTS) {
      const current = hooks[event];
      const groups: unknown[] = Array.isArray(current) ? [...(current as unknown[])] : [];
      groups.push(hookGroup);
      hooks[event] = groups;
    }

    result['hooks'] = hooks;
    return result;
  }

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

  private async locateWorkspace(
    parsed: WorkspaceTeardownRequest
  ): Promise<{ repo: Repository; instance: RawInstance } | null> {
    const repos = await this.repositoryService.getAll();
    for (const repo of repos) {
      const instances = await this.listInstances(repo.localPath);
      const match = instances.find(inst =>
        'workspaceId' in parsed
          ? inst.instanceId === parsed.workspaceId
          : this.samePath(inst.path, parsed.path)
      );
      if (match) {
        return { repo, instance: match };
      }
    }
    return null;
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
