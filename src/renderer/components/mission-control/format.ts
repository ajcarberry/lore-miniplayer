import type { WorkspaceCard } from '../../../shared/types';

// Small display helpers + workspace-flag derivation shared by the Mission
// Control card, idle row, and teardown/provision modals. Pure and unit-tested;
// no fabrication — every value comes from the model's snapshot.

// Whether a workspace has uncommitted or unpushed work — the two conditions
// P3's teardown guard refuses on unless force is set (design 2a's ✕ force
// path). Derived from the model's attention reasons (P9), never invented.
export interface WorkspaceFlags {
  readonly dirty: boolean;
  readonly unpushed: boolean;
  readonly requiresForce: boolean;
}

export function deriveWorkspaceFlags(card: WorkspaceCard): WorkspaceFlags {
  const reasons = card.attention.reasons;
  const dirty = reasons.includes('uncommitted');
  const unpushed = reasons.includes('unpushed') || reasons.includes('diverged');
  return { dirty, unpushed, requiresForce: dirty || unpushed };
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
