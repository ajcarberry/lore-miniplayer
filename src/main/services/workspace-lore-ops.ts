import { lore, LoreError } from '@lore-vcs/sdk';
import type { LoreFluentApi } from '@lore-vcs/sdk';
import { LoreEventTag } from '@lore-vcs/sdk/types/enums';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MainLogger } from '../ipc/logger';
import type { BranchDivergence, LoreFileStatusGroup, Repository } from '../../shared/types';
import { collectEvents } from './lore-events';
import type { LoreEventDataOf } from './lore-events';
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

// Generic Lore SDK execution + error-wrapping helpers shared by WorkspaceService
// operations (extracted so workspace-service.ts stays under the project's
// max-lines limit; decompose per eslint.config.js's size-limit guidance).

export class WorkspaceOperationError extends Error {
  constructor(
    message: string,
    public readonly errorType?: number
  ) {
    super(message);
    this.name = 'WorkspaceOperationError';
  }
}

export function toOperationError(context: string, error: unknown): WorkspaceOperationError {
  if (error instanceof WorkspaceOperationError) {
    return error;
  }
  if (error instanceof LoreError) {
    const firstError = error.loreErrors?.[0];
    return new WorkspaceOperationError(`${context}: ${error.message}`, firstError?.data.errorType);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WorkspaceOperationError(`${context}: ${message}`);
}

// Runs a fluent SDK operation, wrapping any failure as a WorkspaceOperationError.
export async function run(operation: LoreFluentApi, context: string): Promise<void> {
  try {
    await operation.waitAsync();
  } catch (error) {
    throw toOperationError(context, error);
  }
}

// Runs a fluent SDK operation and collects the events matching `tag`, wrapping
// any failure as a WorkspaceOperationError.
export async function collect<TTag extends LoreEventTag, T>(
  operation: LoreFluentApi,
  tag: TTag,
  map: (data: LoreEventDataOf<TTag>) => T | undefined,
  context: string
): Promise<T[]> {
  return collectEvents(operation, tag, map, error => toOperationError(context, error));
}

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
  getBranchDivergence(repositoryPath: string, branchName: string): Promise<BranchDivergence>;
}

// Teardown's unsaved-work guard (C52), failing closed: only an inSync branch
// provably has every local commit on the remote. 'ahead' has unpushed commits
// outright; 'behindOrDiverged' cannot prove the local tip is remote (true
// divergence loses commits too); 'unknown' — typically a provisioned branch
// never pushed, so no remote tip resolves — is allowed only when the branch
// tip still sits at its creation fork point (a fresh branch with no commits
// of its own: the fork revision came from the clone). A tip past the fork
// point, or unresolvable evidence, counts as unpushed work.
export async function assertNoUnsavedWork(
  probe: UnsavedWorkProbe,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const status = await probe.getFileStatus(workspacePath);
  const dirtyCount = status.untracked.length + status.unstaged.length + status.staged.length;
  if (dirtyCount > 0) {
    throw new Error('Workspace has uncommitted changes; pass force to remove it anyway');
  }
  const divergence = await probe.getBranchDivergence(workspacePath, branchName);
  if (divergence.state === 'inSync') {
    return;
  }
  if (divergence.state !== 'unknown') {
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
