import type { MainLogger } from '../ipc/logger';
import { WorkspaceSchema } from '../../shared/schemas';
import type { Repository, Workspace } from '../../shared/types';
import type { WorkspaceRevisionStatus } from './lore-repository';
import { samePath } from './path-utils';

// Resolves the anchor workspace — the card-view repository Mission Control is
// scoped to, surfaced as a listed member the same way a provisioned worktree
// is (packet U1 deferred this composition to U3). Extracted from
// workspace-model.ts to stay under the project's max-lines limit (see
// workspace-lore-ops.ts for the same pattern in WorkspaceService).

export interface AnchorLoreDeps {
  // One repositoryStatus({ revisionOnly: true }) call resolves the checkout's
  // current branch AND revision together (C25) — the anchor is a card-view
  // checkout, not a self-reporting Lore instance.
  getWorkspaceRevisionStatus(repositoryPath: string): Promise<WorkspaceRevisionStatus | undefined>;
}

export interface AnchorDeps {
  readonly repository: { getById(id: string): Promise<Repository | null> };
  readonly lore: AnchorLoreDeps;
}

// The card-view repository this Mission Control snapshot is scoped to
// (`repositoryId` is its own id). Degrades to no anchor — never throws —
// when the repository record is gone or its current branch/revision cannot
// be determined; the caller still renders the repository's provisioned
// members.
export async function resolveAnchorWorkspace(
  log: MainLogger,
  deps: AnchorDeps,
  repositoryId: string
): Promise<Workspace | undefined> {
  const repo = await deps.repository.getById(repositoryId);
  if (!repo) {
    return undefined;
  }
  const status = await safeRevisionStatus(log, deps.lore, repo.localPath);
  if (!status || status.branchName.length === 0) {
    return undefined;
  }
  return WorkspaceSchema.parse({
    instanceId: repo.id,
    path: repo.localPath,
    branchName: status.branchName,
    name: repo.name,
    revision: status.revision,
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
  return [...workspaces.filter(w => !samePath(w.path, anchor.path)), anchor];
}

async function safeRevisionStatus(
  log: MainLogger,
  lore: AnchorLoreDeps,
  repositoryPath: string
): Promise<WorkspaceRevisionStatus | undefined> {
  try {
    return await lore.getWorkspaceRevisionStatus(repositoryPath);
  } catch (error) {
    logDegrade(log, 'anchorStatus', repositoryPath, error);
    return undefined;
  }
}

// Shared with WorkspaceModelService's safe* wrappers (it was extracted from
// the model — see the module note above).
export function logDegrade(
  log: MainLogger,
  signal: string,
  workspacePath: string,
  error: unknown
): void {
  log.debug('Workspace signal degraded', {
    operation: 'workspace-model:signal',
    signal,
    workspacePath,
    error: error instanceof Error ? error.message : String(error),
  });
}
