import type { Repository } from '../../shared/types';

// Validate folder name - no special characters, no reserved Windows names
export function validateRepositoryName(name: string): string | null {
  if (!name) {
    return 'Repository name is required';
  }
  if (name.length > 255) {
    return 'Name too long';
  }

  const invalidChars = /[<>:"/\\|?*]/;
  if (invalidChars.test(name)) {
    return 'Name contains invalid characters';
  }

  const reservedNames = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  if (reservedNames.test(name)) {
    return 'This is a reserved system name';
  }

  return null;
}

// Sanitize repository name by extracting the basename (last path component)
export async function sanitizeRepositoryName(name: string): Promise<string> {
  const result = await window.electronAPI.path.basename(name);
  return result.success ? result.data : name;
}

// Derive a short repo name from a workspace's url for display/grouping
// (e.g. "lores://host/team/demo-project" -> "demo-project"). Falls back to
// the whole url when there is no path segment to extract.
export function repoNameFromUrl(url: string): string {
  const withoutScheme = url.replace(/^[a-zA-Z]+:\/\//, '');
  const segments = withoutScheme.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? url;
}

// The footer selector's per-row label (packet U2): a provisioned worktree's
// registry name is its branch, which reads as a bare branch name on its own —
// prefixing it with the url-derived repo name makes same-repo workspaces
// legible in a flat list (e.g. "demo-project · test/WT1"). Card-view entries
// (attached/cloned) show their plain name, unchanged.
export function workspaceDisplayName(repo: Repository): string {
  if (repo.origin !== 'provisioned') {
    return repo.name;
  }
  return `${repoNameFromUrl(repo.url)} · ${repo.branchName ?? repo.name}`;
}
