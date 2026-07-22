import * as path from 'node:path';
import type { MainLogger } from '../ipc/logger';
import { WorkspaceSchema } from '../../shared/schemas';
import type { LoreBranch, Repository, Workspace } from '../../shared/types';

// Resolves the anchor workspace — the card-view repository Mission Control is
// scoped to, surfaced as a listed member the same way a provisioned worktree
// is (packet U1 deferred this composition to U3). Extracted from
// workspace-model.ts to stay under the project's max-lines limit (see
// workspace-lore-ops.ts for the same pattern in WorkspaceService).

export interface AnchorLoreDeps {
  listBranches(repositoryPath: string): Promise<LoreBranch[]>;
  getCurrentRevision(repositoryPath: string): Promise<string>;
}

export interface AnchorDeps {
  readonly repository: { getById(id: string): Promise<Repository | null> };
  readonly lore: AnchorLoreDeps;
}

// The card-view repository this Mission Control snapshot is scoped to
// (`repositoryId` is its own id). Degrades to no anchor — never throws —
// when the repository record is gone or its current branch cannot be
// determined; the caller still renders the repository's provisioned members.
export async function resolveAnchorWorkspace(
  log: MainLogger,
  deps: AnchorDeps,
  repositoryId: string
): Promise<Workspace | undefined> {
  const repo = await deps.repository.getById(repositoryId);
  if (!repo) {
    return undefined;
  }
  const branchName = await safeCurrentBranch(log, deps.lore, repo.localPath);
  if (branchName === undefined) {
    return undefined;
  }
  const revision = await safeCurrentRevision(log, deps.lore, repo.localPath);
  return WorkspaceSchema.parse({
    instanceId: repo.id,
    path: repo.localPath,
    branchName,
    name: repo.name,
    revision,
    stale: false,
    repositoryId: repo.id,
    origin: repo.origin,
    ...(repo.provisionedAt ? { provisionedAt: repo.provisionedAt } : {}),
  });
}

// Compose the Mission Control member list: the repository's sibling workspaces
// plus the anchor checkout. The sibling list excludes the anchor by registry id
// (WorkspaceService.list), but a second same-repo registry record can resolve
// to the anchor's OWN checkout path (e.g. a duplicate attached entry left by
// migration/heal) which id-exclusion misses — surfacing the anchor's checkout
// twice (a plain member AND the composed anchor). Drop any sibling sharing the
// anchor's resolved path so that checkout is represented exactly once.
export function composeMembers(
  workspaces: Workspace[],
  anchor: Workspace | undefined
): Workspace[] {
  if (!anchor) {
    return workspaces;
  }
  const anchorPath = path.resolve(anchor.path);
  return [...workspaces.filter(w => path.resolve(w.path) !== anchorPath), anchor];
}

async function safeCurrentBranch(
  log: MainLogger,
  lore: AnchorLoreDeps,
  repositoryPath: string
): Promise<string | undefined> {
  try {
    const branches = await lore.listBranches(repositoryPath);
    return branches.find(branch => branch.isCurrent)?.name;
  } catch (error) {
    logDegrade(log, 'anchorBranch', repositoryPath, error);
    return undefined;
  }
}

async function safeCurrentRevision(
  log: MainLogger,
  lore: AnchorLoreDeps,
  repositoryPath: string
): Promise<string> {
  try {
    return await lore.getCurrentRevision(repositoryPath);
  } catch (error) {
    logDegrade(log, 'anchorRevision', repositoryPath, error);
    return '';
  }
}

function logDegrade(log: MainLogger, signal: string, workspacePath: string, error: unknown): void {
  log.debug('Workspace signal degraded', {
    operation: 'workspace-model:signal',
    signal,
    workspacePath,
    error: error instanceof Error ? error.message : String(error),
  });
}
