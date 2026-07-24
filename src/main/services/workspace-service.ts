import { lore } from '@lore-vcs/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MainLogger } from '../ipc/logger';
import type { RepositoryService } from './repository';
import type { LoreRepositoryService } from './lore-repository';
import {
  run,
  safeLoreRepositoryId,
  membersOfRepo,
  repoForEntry,
  listInstances,
  assertWithinRoot,
  assertSafeTeardownPath,
  assertNoUnsavedWork,
  WorkspaceOperationError,
} from './workspace-lore-ops';
import type { RawInstance } from './workspace-lore-ops';
import { WorkspaceRegistry } from './workspace-store';
import { writeObserverHooks } from './workspace-hooks';
import type { WorkspaceObserverConfig } from './workspace-hooks';
import type {
  Repository,
  Workspace,
  WorkspaceForgetRequest,
  WorkspaceOrigin,
  WorkspaceProvisionRequest,
  WorkspaceTeardownRequest,
  WorkspaceTeardownResult,
} from '../../shared/types';
import { WorkspaceSchema } from '../../shared/schemas';
import { pathExists, samePath } from './path-utils';

// Worktree directories are placed as a sibling of the repository's own
// checkout, under `<repoName>-wt/<branch>` (design 2a). The suffix keeps the
// worktree root visibly adjacent to, and distinct from, the repo directory.
const WORKTREE_DIR_SUFFIX = '-wt';

// Re-exported so existing importers (agent-observer) keep their import site.
export type { WorkspaceObserverConfig } from './workspace-hooks';
// Re-exported so existing importers (e.g. tests) keep their import site.
export { WorkspaceOperationError } from './workspace-lore-ops';

// Provisions, lists, and tears down agent workspaces ("worktrees"): a branch
// checked out in a new directory backed by Lore's shared store, with Claude
// Code observer hooks injected. Teardown is destructive and double-guarded
// (see teardown). SDK connectivity for the clone is a hard dependency (P1
// finding b: clone contacts the repo's real server); the shape here follows
// the documented-best path and is exercised through mocks, with the
// live-server flow integration-pending.
export class WorkspaceService extends EventEmitter {
  // Absent until the observer injects its live port + token provider via
  // `setObserverConfig` (C31: no fabricated fallback — a hook embedding a
  // token the listener never registered could only ever 403, so hook writing
  // is skipped entirely while the config is absent).
  private observerConfig: WorkspaceObserverConfig | undefined;

  // The unified workspace registry (workspaces.json, packet U1). The source of
  // truth for WHICH workspaces exist: Lore's instance registry is PER-STORE, so
  // the repository's primary checkout cannot see its shared-store worktrees
  // (P18 live finding). Provisioned worktrees are stored here as unified
  // entries (origin 'provisioned') alongside card-view repositories; grouping
  // by a repo's Lore identity (loreRepositoryId, falling back to url — see
  // sameLoreRepo) finds its worktrees. Live fields are enriched from each
  // workspace's OWN path at read time.
  private readonly store: WorkspaceRegistry;

  // Workspace paths with a provision currently in flight (P10): a second
  // concurrent provision for the same directory would race the exists-check
  // and clone over the first (its failure cleanup rm -rf'ing the winner's
  // half-built checkout), so it is refused until the first settles.
  private readonly inFlightProvisions = new Set<string>();

  constructor(
    private readonly log: MainLogger,
    private readonly repositoryService: RepositoryService,
    private readonly loreRepositoryService: LoreRepositoryService,
    observerConfig?: WorkspaceObserverConfig,
    // Injected in production (index.ts) so RepositoryService and this service
    // share ONE registry instance — serializing their read-modify-write
    // cycles through the same queue (C56). Optional so tests construct as
    // before.
    store?: WorkspaceRegistry
  ) {
    super();
    this.store = store ?? new WorkspaceRegistry(log);
    this.observerConfig = observerConfig;
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
    // Validated at the IPC boundary (validators.ts); typed in-process here.
    const { repositoryId, branchName } = request;

    const repo = await this.repositoryService.getById(repositoryId);
    if (!repo) {
      throw new Error(`Repository with id "${repositoryId}" not found`);
    }

    const worktreeRoot = this.worktreeRootFor(repo.localPath);
    const workspacePath = path.join(worktreeRoot, branchName);
    assertWithinRoot(workspacePath, worktreeRoot);

    // One provision per target directory (P10): a concurrent second call
    // would pass the exists-check below while the first is still cloning.
    const inFlightKey = path.resolve(workspacePath);
    if (this.inFlightProvisions.has(inFlightKey)) {
      throw new Error(`A provision is already in flight for this workspace: ${workspacePath}`);
    }
    this.inFlightProvisions.add(inFlightKey);
    try {
      return await this.provisionAt(repo, workspacePath, branchName);
    } finally {
      this.inFlightProvisions.delete(inFlightKey);
    }
  }

  // The body of provision() past its request/uniqueness guards, run with the
  // target directory's in-flight lock held.
  private async provisionAt(
    repo: Repository,
    workspacePath: string,
    branchName: string
  ): Promise<Workspace> {
    if (await pathExists(workspacePath)) {
      // Adoption (P18): a directory that already exists AND self-reports a
      // matching-branch instance is an orphaned workspace (e.g. provisioned by
      // the pre-fix flow that never persisted a registry entry). Heal it into
      // the registry instead of failing outright.
      const adopted = await this.adoptExisting(workspacePath, branchName, repo);
      if (adopted) {
        this.emit('lifecycle');
        return adopted;
      }
      throw new Error(`Workspace directory already exists: ${workspacePath}`);
    }

    await fs.mkdir(path.dirname(workspacePath), { recursive: true });

    try {
      await run(
        lore.repositoryClone(
          { repositoryPath: workspacePath },
          { repositoryUrl: repo.url, useSharedStore: true, sharedStorePath: '' }
        ),
        `Failed to clone workspace for repository "${repo.name}"`
      );
      await run(
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
    await this.upsertProvisioned(repo, workspacePath, branchName, provisionedAt);
    this.emit('lifecycle');
    return this.toWorkspace(match, repo.id, 'provisioned', branchName, provisionedAt);
  }

  // List every OTHER workspace of the repository: its provisioned worktrees
  // AND any sibling attached/cloned checkout of the same Lore repo (the
  // workspace-unification amendment — every workspace of the selected repo
  // must appear, regardless of how it was created). The persistent registry
  // is the source of truth for WHICH workspaces exist (P18: the primary
  // checkout's per-store registry cannot see shared-store worktrees). Each
  // entry is enriched from its OWN path (branch/revision/stale via
  // self-report); a missing directory or a failed query yields a stale row
  // rather than throwing, so Mission Control still shows it.
  async list(repositoryId: string): Promise<Workspace[]> {
    const repo = await this.repositoryService.getById(repositoryId);
    if (!repo) {
      throw new Error(`Repository with id "${repositoryId}" not found`);
    }
    // Workspaces belonging to the same Lore repo are its siblings (grouping
    // prefers loreRepositoryId, falling back to url — packet U1 + the attach
    // unification amendment). The anchor's own entry is excluded here —
    // surfacing it as a Mission Control member, marked isActive, is U3's job.
    const entries = membersOfRepo(await this.store.all(), repo);
    const workspaces: Workspace[] = [];
    for (const entry of entries) {
      const instance = await this.enrichEntry(entry);
      workspaces.push(
        instance
          ? this.toWorkspace(instance, repo.id, entry.origin, entry.name, entry.provisionedAt)
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
    const located = await this.locateWorkspace(request);
    if (!located) {
      throw new Error('Workspace not found or not a tracked instance');
    }
    const { repo, entry, instance } = located;
    // The registry is the source of truth for the path; the branch name comes
    // from the registry too, so a missing/stale live instance can't strand it.
    // Only a provisioned entry carries a branch of its own (C51): an
    // attached/cloned entry's display name must never be used as one — it
    // could collide with a real branch in the shared store.
    const workspacePath = entry.localPath;
    const branchName = entry.branchName;

    // Attached/cloned entries are first-class repository checkouts, not
    // worktrees the app provisioned — a bare teardown request can never
    // remove one, regardless of dirty/unpushed state; the caller must
    // explicitly confirm (force). Provisioned worktrees keep the existing
    // force-only-when-dirty behavior below.
    if (entry.origin !== 'provisioned' && !request.force) {
      throw new Error('This is a repository checkout — closing it requires explicit confirmation');
    }

    // The "not the repo's own checkout" guard only makes sense for a
    // provisioned worktree accidentally sharing its parent's path — a
    // card-view (attached/cloned) entry IS its own repo record, so this
    // check would trivially refuse every one of them (breaking the
    // amendment's non-anchor teardown affordance) if applied here too.
    const guardRepoPath = entry.origin === 'provisioned' ? repo?.localPath : undefined;
    await assertSafeTeardownPath(workspacePath, guardRepoPath);

    if (!request.force) {
      // Only reachable for provisioned entries (attached/cloned ones already
      // threw above without force), so entry.branchName is present; the name
      // fallback keeps a degenerate entry fail-closed rather than crashing.
      await assertNoUnsavedWork(
        this.loreRepositoryService,
        workspacePath,
        branchName ?? entry.name
      );
    }

    this.log.info('Workspace teardown: removing directory', {
      operation: 'workspace:teardown',
      workspacePath,
    });
    await fs.rm(workspacePath, { recursive: true, force: true });
    await this.store.removeByLocalPath(workspacePath);

    // Prune + archive act on the SHARED store, not the primary checkout's
    // private store (P18). Both require a live handle into that store, so they
    // run against ANOTHER registered workspace of the same repo (a sibling that
    // shares the store, found by url). Tearing down the last one leaves a
    // harmless orphan record in the now-unreferenced store — skip with a log
    // line.
    const sibling = await this.siblingWorkspacePath(entry, workspacePath);

    let localBranchRemoved = false;
    if (sibling) {
      localBranchRemoved = await this.pruneAndArchive(sibling, workspacePath, branchName);
    } else {
      this.log.info(
        'Workspace teardown: no sibling workspace in the shared store; skipping prune + archive',
        { operation: 'workspace:teardown', workspacePath, branch: branchName }
      );
    }

    this.emit('lifecycle');
    return {
      workspaceId: instance?.instanceId ?? workspacePath,
      path: workspacePath,
      directoryRemoved: true,
      localBranchRemoved,
      // Remote-branch removal is a server ask, not implemented (P1 finding d).
      remoteBranchRemoved: false,
    };
  }

  // "Forget" a workspace (design amendment, packet U3): untrack-only — drops
  // the registry entry so it stops appearing in Mission Control, but never
  // touches the worktree directory or the branch. The guarded, destructive
  // path is `teardown`; identification (id or path) is resolved the same way.
  async forget(request: WorkspaceForgetRequest): Promise<void> {
    const located = await this.locateWorkspace(request);
    if (!located) {
      throw new Error('Workspace not found or not a tracked instance');
    }
    await this.store.removeByLocalPath(located.entry.localPath);
    this.log.info('Workspace forgotten (untracked, files left in place)', {
      operation: 'workspace:forget',
      workspacePath: located.entry.localPath,
    });
    this.emit('lifecycle');
  }

  // Write Claude Code observer hooks into the workspace's settings.local.json.
  // Public so P7 can re-inject if it rotates tokens; the writer itself lives in
  // ./workspace-hooks. A no-op (logged) until the observer's real config is
  // injected — see the observerConfig field note.
  async writeObserverHooks(workspacePath: string): Promise<void> {
    if (!this.observerConfig) {
      this.log.warn('No observer config injected; skipping observer hook write', {
        operation: 'workspace:writeObserverHooks',
        workspacePath,
      });
      return;
    }
    await writeObserverHooks(this.log, workspacePath, this.observerConfig);
  }

  // Re-write observer hooks for every provisioned workspace in the registry
  // (C53): observer tokens are minted in-memory per process, so hooks written
  // by a previous run embed tokens this run's listener would reject. Called at
  // startup once the live observer config is injected; a missing directory is
  // skipped and per-workspace failures are logged, never thrown.
  async reinjectObserverHooks(): Promise<void> {
    const entries = await this.store.all();
    for (const entry of entries) {
      if (entry.origin !== 'provisioned' || !(await pathExists(entry.localPath))) {
        continue;
      }
      try {
        await this.writeObserverHooks(entry.localPath);
      } catch (error) {
        this.log.error('Failed to re-inject observer hooks for workspace', {
          error,
          operation: 'workspace:reinjectObserverHooks',
          workspacePath: entry.localPath,
        });
      }
    }
  }

  // --- internals ------------------------------------------------------------

  private worktreeRootFor(repoLocalPath: string): string {
    const parent = path.dirname(repoLocalPath);
    const repoName = path.basename(repoLocalPath);
    return path.join(parent, `${repoName}${WORKTREE_DIR_SUFFIX}`);
  }

  // Prune the removed instance and archive its branch in the SHARED store via
  // the sibling's handle (see teardown). Only a provisioned entry carries a
  // branch of its own to archive (C51): an attached/cloned entry has no
  // branchName, and its display name must never be used as one. Both steps
  // continue-on-error (logged); returns whether the local branch was archived.
  private async pruneAndArchive(
    sibling: string,
    workspacePath: string,
    branchName: string | undefined
  ): Promise<boolean> {
    try {
      await run(
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
    if (branchName === undefined) {
      this.log.info('Workspace teardown: entry carries no provisioned branch; skipping archive', {
        operation: 'workspace:teardown',
        workspacePath,
      });
      return false;
    }
    try {
      await run(
        lore.branchArchive({ repositoryPath: sibling }, { branch: branchName }),
        'Failed to archive local branch'
      );
      return true;
    } catch (error) {
      this.log.error('Workspace teardown: failed to archive local branch (continuing)', {
        error,
        operation: 'workspace:teardown',
        branch: branchName,
      });
      return false;
    }
  }

  // Write (or refresh) a provisioned worktree as a unified registry entry
  // (origin 'provisioned'), keyed by resolved localPath so re-provisioning or
  // adopting the same directory never duplicates it. `name` is the branch
  // (name uniqueness is per-url), `url` links it to its parent repo, and the
  // stable `loreRepositoryId` (resolved at the worktree's own path, non-fatal)
  // is the preferred grouping key — falling back to a prior stamp so a
  // transient resolution failure never drops a known id.
  private async upsertProvisioned(
    repo: Repository,
    workspacePath: string,
    branchName: string,
    provisionedAt: string
  ): Promise<void> {
    const existing = await this.store.findByLocalPath(workspacePath);
    const resolvedId =
      (await safeLoreRepositoryId(this.loreRepositoryService, this.log, workspacePath)) ??
      existing?.loreRepositoryId;
    const entry: Repository = {
      id: existing?.id ?? (randomUUID() as string),
      name: branchName,
      url: repo.url,
      ...(resolvedId ? { loreRepositoryId: resolvedId } : {}),
      localPath: workspacePath,
      accentHue: existing?.accentHue ?? (await this.store.nextAccentHue()),
      origin: 'provisioned',
      branchName,
      provisionedAt,
      createdAt: existing?.createdAt ?? provisionedAt,
      updatedAt: new Date().toISOString(),
    };
    await this.store.upsertByLocalPath(entry);
  }

  // Adopt an already-on-disk workspace into the registry when it self-reports a
  // matching-branch instance. Returns the adopted Workspace, or undefined when
  // the directory is not a matching workspace (so the caller can refuse).
  private async adoptExisting(
    workspacePath: string,
    branchName: string,
    repo: Repository
  ): Promise<Workspace | undefined> {
    const match = await this.selfInstance(workspacePath);
    if (!match || match.branchName !== branchName) {
      return undefined;
    }
    const existing = await this.store.findByLocalPath(workspacePath);
    const provisionedAt = existing?.provisionedAt ?? new Date().toISOString();
    await this.upsertProvisioned(repo, workspacePath, branchName, provisionedAt);
    this.log.info('Adopted an existing workspace into the registry', {
      operation: 'workspace:provision',
      workspacePath,
      branch: branchName,
    });
    return this.toWorkspace(match, repo.id, 'provisioned', branchName, provisionedAt);
  }

  // Resolve a teardown or forget request to its registry entry (the source of
  // truth), enriched with the live instance where available — any origin (the
  // amendment's non-anchor removal affordances apply to attached/cloned
  // siblings too, not just provisioned worktrees). A `workspaceId` matches
  // either the live instance id or the synthetic id used for stale rows (the
  // path); a `path` matches the registry entry directly. `repo` is the parent
  // card-view repo (matched by url) for a provisioned worktree, or the entry
  // itself when it already IS a card-view (attached/cloned) entry — used for
  // the checkout-safety guard and lifecycle attribution.
  private async locateWorkspace(
    parsed: { workspaceId: string } | { path: string }
  ): Promise<{ repo?: Repository; entry: Repository; instance?: RawInstance } | null> {
    const cardRepos = await this.repositoryService.getAll();
    const entries = await this.store.all();
    for (const entry of entries) {
      const repo = repoForEntry(entry, cardRepos);
      const instance = await this.enrichEntry(entry);
      const matches =
        'workspaceId' in parsed
          ? instance?.instanceId === parsed.workspaceId ||
            samePath(entry.localPath, parsed.workspaceId)
          : samePath(entry.localPath, parsed.path);
      if (matches) {
        return { ...(repo ? { repo } : {}), entry, ...(instance ? { instance } : {}) };
      }
    }
    return null;
  }

  // The live instance a workspace path self-reports for its own directory (its
  // shared store lists it). Undefined when the directory is gone or the query
  // fails — never throws (P18 enrichment contract).
  private async enrichEntry(entry: Repository): Promise<RawInstance | undefined> {
    if (!(await pathExists(entry.localPath))) {
      return undefined;
    }
    return this.selfInstance(entry.localPath);
  }

  private async selfInstance(workspacePath: string): Promise<RawInstance | undefined> {
    try {
      const instances = await listInstances(workspacePath);
      return instances.find(inst => samePath(inst.path, workspacePath));
    } catch (error) {
      this.log.error('Failed to self-report workspace instance (treating as stale)', {
        error,
        operation: 'workspace:enrich',
        workspacePath,
      });
      return undefined;
    }
  }

  // Another registered worktree of the same repo (sharing the same Lore store),
  // excluding the one being torn down. Prune/archive run against it. Only a
  // provisioned entry can share `anchor`'s shared store (attached/cloned
  // checkouts have none of their own to share).
  private async siblingWorkspacePath(
    anchor: Repository,
    excludePath: string
  ): Promise<string | undefined> {
    const members = membersOfRepo(await this.store.all(), anchor);
    const sibling = members.find(
      entry => entry.origin === 'provisioned' && !samePath(entry.localPath, excludePath)
    );
    return sibling?.localPath;
  }

  // A stale Mission Control row for a registered workspace whose directory is
  // gone or whose store cannot be queried. The path doubles as a stable
  // synthetic instance id (the live id is unknown).
  private staleWorkspace(entry: Repository, repositoryId: string): Workspace {
    return WorkspaceSchema.parse({
      instanceId: entry.localPath,
      path: entry.localPath,
      branchName: entry.branchName ?? entry.name,
      name: entry.name,
      revision: '',
      stale: true,
      repositoryId,
      origin: entry.origin,
      ...(entry.provisionedAt ? { provisionedAt: entry.provisionedAt } : {}),
    });
  }

  private toWorkspace(
    inst: RawInstance,
    repositoryId: string,
    origin: WorkspaceOrigin,
    name: string,
    provisionedAt?: string
  ): Workspace {
    return WorkspaceSchema.parse({
      instanceId: inst.instanceId,
      path: inst.path,
      branchName: inst.branchName,
      name,
      revision: inst.revision,
      stale: inst.stale,
      repositoryId,
      origin,
      ...(provisionedAt ? { provisionedAt } : {}),
    });
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
}
