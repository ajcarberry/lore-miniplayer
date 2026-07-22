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

// The footer selector's per-row label: the workspace's own identity only —
// its registry `name` for card-view entries (attached/cloned), or its
// `branchName` for a provisioned worktree (whose registry name is a
// sanitized version of the branch, e.g. "test-WT1" for "test/WT1"). The
// repo this workspace belongs to is no longer repeated here; the footer
// groups rows under a per-repo `Menu.Label` instead (see
// `groupWorkspacesByRepo`).
export function workspaceDisplayName(repo: Repository): string {
  if (repo.origin !== 'provisioned') {
    return repo.name;
  }
  return repo.branchName ?? repo.name;
}

// Loose equality for judging whether a workspace's own name is "the same
// idea" as another string (a repo name or a branch name): case and any
// punctuation/whitespace differences don't count (e.g. "Demo Project" ~
// "demo-project", "test-WT1" ~ "test/WT1").
function sameIdentity(a: string, b: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(a) === normalize(b);
}

// The card header + pill eyebrow label (identity fix): always anchored to
// the repo name derived from the workspace's `url`, since that's the
// identity a human recognizes regardless of which local workspace they
// picked. The workspace's own `name` is appended only when it carries new
// information over the repo name — the current branch plays no part in this
// decision (a workspace can coincidentally be named after its own branch
// while still being a distinctly-named sibling of the repo, and that
// distinction is the whole point of the suffix).
export function repoEyebrowLabel(repository: Repository): string {
  const repoName = repoNameFromUrl(repository.url);
  return sameIdentity(repository.name, repoName) ? repoName : `${repoName} · ${repository.name}`;
}

export interface RepoGroup {
  readonly key: string;
  readonly repoName: string;
  readonly workspaces: Repository[];
}

// Groups workspace entries by their underlying Lore repository for the footer
// selector (and, via delegation, Mission Control's header switcher). Two
// entries belong to the same group when they share a `loreRepositoryId` OR a
// `url` — transitively: a union over BOTH identity dimensions. A per-entry
// `loreRepositoryId ?? url` key is NOT enough — it splits the original attach
// entry (url only) from its healed sibling (same url + resolved id), since one
// keys by url and the other by id even though they are the same repo (the
// "false split" bug). The group `key` still prefers a member's stable
// `loreRepositoryId`, falling back to a url. Groups, and the workspaces within
// them, preserve first-seen order from the input list.
export function groupWorkspacesByRepo(repositories: readonly Repository[]): RepoGroup[] {
  // Union-find over identity keys. Keys are namespaced (`id:`/`url:`) so a url
  // value can never collide with an id value; a shared key string transitively
  // links every entry that references it.
  const parent = new Map<string, string>();
  const ensure = (key: string): void => {
    if (!parent.has(key)) {
      parent.set(key, key);
    }
  };
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let cursor = key;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    ensure(a);
    ensure(b);
    parent.set(find(a), find(b));
  };
  const keysOf = (repo: Repository): string[] => {
    const keys = [`url:${repo.url}`];
    if (repo.loreRepositoryId !== undefined) {
      keys.push(`id:${repo.loreRepositoryId}`);
    }
    return keys;
  };

  // Link each entry's own keys together; shared key strings do the cross-entry
  // merging automatically (two entries with the same url land in one component,
  // and an entry carrying both url + id bridges the two dimensions).
  for (const repo of repositories) {
    const keys = keysOf(repo);
    keys.forEach(ensure);
    for (let i = 1; i < keys.length; i += 1) {
      union(keys[0]!, keys[i]!);
    }
  }

  // Assign entries to their component's group, preserving first-seen order.
  const order: string[] = [];
  const membersByRoot = new Map<string, Repository[]>();
  for (const repo of repositories) {
    const root = find(keysOf(repo)[0]!);
    let members = membersByRoot.get(root);
    if (!members) {
      members = [];
      membersByRoot.set(root, members);
      order.push(root);
    }
    members.push(repo);
  }

  return order.map(root => {
    const members = membersByRoot.get(root)!;
    const withId = members.find(member => member.loreRepositoryId !== undefined);
    const key = withId?.loreRepositoryId ?? members[0]!.url;
    return { key, repoName: repoNameFromUrl(members[0]!.url), workspaces: members };
  });
}
