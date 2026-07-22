import type { Repository, WorkspaceCard } from '../../../shared/types';
import { groupWorkspacesByRepo, repoNameFromUrl } from '../../utils/repository-name';

// Small display helpers + workspace-flag derivation shared by the Mission
// Control card, idle row, and teardown/provision modals. Pure and unit-tested;
// no fabrication — every value comes from the model's snapshot.

// Whether a workspace has uncommitted or unpushed work — the two conditions
// P3's teardown guard refuses on unless force is set (design 2a's ✕ force
// path). Derived from the model's attention reasons (P9), never invented.
// `isRepoCheckout` is a SEPARATE, origin-driven requirement (the workspace-
// unification amendment's hardening): an attached/cloned entry is a real
// repository checkout, not an app-provisioned worktree, so closing it always
// needs explicit confirmation regardless of dirty/unpushed state.
export interface WorkspaceFlags {
  readonly dirty: boolean;
  readonly unpushed: boolean;
  readonly requiresForce: boolean;
  readonly isRepoCheckout: boolean;
}

export function deriveWorkspaceFlags(card: WorkspaceCard): WorkspaceFlags {
  const reasons = card.attention.reasons;
  const dirty = reasons.includes('uncommitted');
  const unpushed = reasons.includes('unpushed') || reasons.includes('diverged');
  const isRepoCheckout = card.workspace.origin !== 'provisioned';
  return { dirty, unpushed, requiresForce: dirty || unpushed, isRepoCheckout };
}

// The per-workspace cost, preferring the live session total, falling back to
// the transcript-derived total. `null` when neither is observed (degraded).
export function resolveCostUsd(card: WorkspaceCard): number | null {
  const cost = card.session?.costUsd ?? card.intention?.costUsd;
  return cost === undefined ? null : cost;
}

export function formatCost(costUsd: number | null): string | null {
  return costUsd === null ? null : `$${costUsd.toFixed(2)}`;
}

// A running task's elapsed time, e.g. "7m 12s" / "45s".
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// A coarse age label for a session commit, e.g. "6m" / "3h" / "2d". The SDK's
// revision timestamp may arrive in seconds or milliseconds; values below the
// year-2001 millisecond epoch are treated as seconds. Returns null when the
// timestamp was dropped (hash-only revision).
export function formatCommitAge(timestamp: number | undefined, now = Date.now()): string | null {
  if (timestamp === undefined) {
    return null;
  }
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const diffMinutes = Math.floor((now - ms) / 60_000);
  if (diffMinutes < 1) {
    return '<1m';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  return `${Math.floor(diffHours / 24)}d`;
}

// A repo-switcher option (header repo switcher amendment): the registry lists
// one entry per workspace, so an attached sibling of the same Lore repo (e.g.
// "adfa" alongside "demo-project") otherwise shows up as its own bogus repo.
// The same-repo grouping is the shared `groupWorkspacesByRepo` union-merge (so
// an entry with only a url and its healed sibling carrying the same url + a
// resolved id never split); this option adds representative selection on top.
export interface RepositoryGroup {
  readonly key: string;
  readonly name: string;
  // The member id passed to the existing watch/open API when this group is
  // selected — prefers a real repository checkout (attached/cloned) over a
  // provisioned worktree, falling back to any member.
  readonly representativeId: string;
  readonly memberIds: readonly string[];
}

export function groupRepositoriesByRepo(repositories: readonly Repository[]): RepositoryGroup[] {
  return groupWorkspacesByRepo(repositories).map(group => {
    const members = group.workspaces;
    const representative =
      members.find(m => m.origin === 'attached' || m.origin === 'cloned') ?? members[0]!;
    return {
      key: group.key,
      name: repoNameFromUrl(representative.url),
      representativeId: representative.id,
      memberIds: members.map(m => m.id),
    };
  });
}

// The switcher's currently-selected group — whichever group has the selected
// repository id as a member. `null` selection (no repo yet) never matches.
export function selectedRepositoryGroup(
  groups: readonly RepositoryGroup[],
  selectedRepositoryId: string | null
): RepositoryGroup | null {
  return groups.find(group => group.memberIds.includes(selectedRepositoryId ?? '')) ?? null;
}

// Preview the worktree directory the provision flow will create, mirroring
// WorkspaceService's layout: `<repo parent>/<repo>-wt/<branch>`. Pure string
// math (no node:path in the renderer); tolerant of either separator and a
// trailing slash.
export function previewWorkspaceDir(repoLocalPath: string, branchName: string): string {
  const normalized = repoLocalPath.replace(/[\\/]+$/, '');
  const sep = normalized.includes('\\') ? '\\' : '/';
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const parent = cut >= 0 ? normalized.slice(0, cut) : '';
  const repoName = cut >= 0 ? normalized.slice(cut + 1) : normalized;
  const leaf = branchName.trim().length > 0 ? branchName.trim() : '<branch>';
  return `${parent}${sep}${repoName}-wt${sep}${leaf}`;
}
