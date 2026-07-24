import { lore } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MainLogger } from '../ipc/logger';
import type { LoreFileStatusGroup, Repository } from '../../shared/types';
import type { LoreEventDataOf } from './lore-events';
import { OperationError, operationHelpers } from './lore-operation';
import type { WorkspaceRevisionStatus } from './lore-repository';
import { isDirty } from './lore-status';
import { isUnknownHash } from './branch-graph';
import { sameLoreRepo } from './workspace-store';

// Registry entries of the same Lore repo as `anchor`, any origin, excluding
// the anchor's own entry — every OTHER workspace of the selected repo
// (provisioned worktrees AND sibling attached/cloned checkouts alike). Used
// by `WorkspaceService.list` (the workspace-unification amendment: every
// workspace of the selected repo is a Mission Control member). Extracted to
// keep workspace-service.ts under the project's max-lines limit.
export function membersOfRepo(entries: Repository[], anchor: Repository): Repository[] {
  return entries.filter(entry => entry.id !== anchor.id && sameLoreRepo(entry, anchor));
}

// The card-view repo `entry` belongs to: a provisioned worktree's parent
// (found among `cardRepos` by matching Lore repo), or `entry` itself when it
// already IS a card-view (attached/cloned) entry. Used by
// `WorkspaceService.locateWorkspace` for the teardown checkout guard and
// lifecycle attribution.
export function repoForEntry(entry: Repository, cardRepos: Repository[]): Repository | undefined {
  return entry.origin === 'provisioned'
    ? cardRepos.find(candidate => sameLoreRepo(candidate, entry))
    : entry;
}

// The narrow slice of LoreRepositoryService the id-resolution helper needs.
interface LoreIdentityResolver {
  resolveRepositoryIdentity(
    repositoryPath: string
  ): Promise<{ loreRepositoryId?: string } | undefined>;
}

// Resolve a workspace checkout's stable Lore repository id (the grouping key),
// swallowing every failure into `undefined` — non-fatal: grouping degrades to
// url and provisioning is never blocked. Logged for diagnostics.
export async function safeLoreRepositoryId(
  resolver: LoreIdentityResolver,
  log: MainLogger,
  workspacePath: string
): Promise<string | undefined> {
  try {
    const identity = await resolver.resolveRepositoryIdentity(workspacePath);
    return identity?.loreRepositoryId;
  } catch (error) {
    log.warn('Failed to resolve workspace loreRepositoryId (continuing)', {
      error,
      operation: 'workspace:provision',
      workspacePath,
    });
    return undefined;
  }
}

// WorkspaceService's typed operation error + run/collect helpers, derived from
// the shared scaffold in ./lore-operation.

export class WorkspaceOperationError extends OperationError {
  constructor(message: string, errorType?: number) {
    super(message, errorType);
    this.name = 'WorkspaceOperationError';
  }
}

export const { toOperationError, run, collect } = operationHelpers(WorkspaceOperationError);

// --- provision + teardown guards (moved from workspace-service.ts to keep it
// under the project's max-lines limit) ---------------------------------------

// The new workspace directory must be a strict subdirectory of the worktree
// root (branch names may carry traversal segments).
export function assertWithinRoot(target: string, root: string): void {
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

// Teardown may never remove the repo's own checkout or follow a symlinked
// workspace path out of the workspace root.
export async function assertSafeTeardownPath(
  workspacePath: string,
  repoLocalPath?: string
): Promise<void> {
  const resolved = path.resolve(workspacePath);
  if (repoLocalPath !== undefined && resolved === path.resolve(repoLocalPath)) {
    throw new Error('Refusing to remove the repository checkout itself');
  }
  const stats = await fs.lstat(resolved).catch(() => null);
  if (stats?.isSymbolicLink()) {
    throw new Error('Refusing to remove a symlinked workspace path');
  }
}

// The narrow slice of LoreRepositoryService the unsaved-work guard needs.
interface UnsavedWorkProbe {
  getFileStatus(repositoryPath: string): Promise<LoreFileStatusGroup>;
  getWorkspaceRevisionStatus(repositoryPath: string): Promise<WorkspaceRevisionStatus | undefined>;
}

// Teardown's unsaved-work guard (C52), failing closed: only an inSync branch
// provably has every local commit on the remote. 'ahead' has unpushed commits
// outright; 'behindOrDiverged' cannot prove the local tip is remote (true
// divergence loses commits too); 'unknown' — typically a provisioned branch
// never pushed, so no remote tip resolves, and also the fallback when the
// status probe streams nothing — is allowed only when the branch tip still
// sits at its creation fork point (a fresh branch with no commits of its own:
// the fork revision came from the clone). A tip past the fork point, or
// unresolvable evidence, counts as unpushed work. Divergence comes from one
// repositoryStatus({ revisionOnly: true }) call (C27) — a teardown target is
// its branch's own checkout, so the current-branch answer is the right one.
export async function assertNoUnsavedWork(
  probe: UnsavedWorkProbe,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const status = await probe.getFileStatus(workspacePath);
  if (isDirty(status)) {
    throw new Error('Workspace has uncommitted changes; pass force to remove it anyway');
  }
  const revisionStatus = await probe.getWorkspaceRevisionStatus(workspacePath);
  const state = revisionStatus?.divergence.state ?? 'unknown';
  if (state === 'inSync') {
    return;
  }
  if (state !== 'unknown') {
    throw new Error('Workspace has unpushed commits; pass force to remove it anyway');
  }
  const fork = await getBranchFork(workspacePath, branchName);
  if (isUnknownHash(fork.latest) || fork.latest !== fork.branchPoint) {
    throw new Error('Workspace has unpushed commits; pass force to remove it anyway');
  }
}

// The branch's local tip alongside its creation fork point (BRANCH_INFO's
// branchPoint) — the unsaved-work guard's evidence for never-pushed branches.
// Absent hashes degrade to '' (an unknown hash) so the guard fails closed.
export async function getBranchFork(
  repositoryPath: string,
  branchName: string
): Promise<{ latest: string; branchPoint: string }> {
  const entries = await collect(
    lore.branchInfo({ repositoryPath }, { branch: branchName }),
    LoreEventTag.BRANCH_INFO,
    (data: LoreEventDataOf<LoreEventTag.BRANCH_INFO>) => ({
      latest: String(data.latest),
      branchPoint: String(data.branchPoint),
    }),
    `Failed to get branch info for '${branchName}'`
  );
  const info = entries[entries.length - 1];
  return { latest: info?.latest ?? '', branchPoint: info?.branchPoint ?? '' };
}

// A live instance a Lore checkout self-reports from its own store
// (`repositoryInstanceList`) — a shared-store clone member or a private
// checkout's sole record (P18: the registry is per-store).
export interface RawInstance {
  instanceId: string;
  path: string;
  branchName: string;
  branch: string;
  revision: string;
  stale: boolean;
}

// The live instances `repositoryPath`'s OWN Lore store self-reports (P18: a
// per-store registry — the primary checkout's private store sees only
// itself; a shared-store clone sees every member). Wrapped as a
// WorkspaceOperationError on failure. Extracted (with `RawInstance`) to keep
// workspace-service.ts under the project's max-lines limit.
export async function listInstances(repositoryPath: string): Promise<RawInstance[]> {
  return collect(
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
