import { lore } from '@lore-vcs/sdk';
import {
  LoreBranchLocation,
  LoreEventTag,
  LoreLogLevel,
  LoreMetadataTag,
} from '@lore-vcs/sdk/types/enums';
import type { BranchGraph, BranchGraphParentLane, RevisionSummary } from '../../shared/types';
import { collectEvents } from './lore-events';

// The parent lane is walked from the parent branch's tip; a very long parent
// history is capped (with a logged note) so the graph assembly stays bounded.
const PARENT_LANE_CAP = 100;

// A hash that is empty or entirely zeros signals "no revision known" (e.g.
// an unpublished branch with no remote counterpart yet).
export function isUnknownHash(hash: string): boolean {
  return hash.length === 0 || /^0+$/.test(hash);
}

// A raw revision-history entry as streamed by the SDK, retaining the parent
// tuple (direct + other) needed for merge classification before enrichment
// narrows it to a RevisionSummary.
interface RawRevision {
  readonly revision: string;
  readonly revisionNumber: number;
  readonly parent: readonly [string, string];
}

// A branchList entry reduced to the fields the graph needs: id/name for
// parent resolution, latest as the walk anchor, and location to prefer the
// local copy when both local and remote entries exist.
interface BranchEntry {
  readonly id: string;
  readonly name: string;
  readonly latest: string;
  readonly isCurrent: boolean;
  readonly location: LoreBranchLocation;
}

// Collaborators the graph assembly needs from the owning service:
// structured logging and contextual error wrapping.
export interface BranchGraphDeps {
  readonly emitLog: (level: LoreLogLevel, message: string) => void;
  readonly wrapError: (context: string, error: unknown) => Error;
}

// Picks the most useful entry for a branch that appears more than once
// (typically a local + a remote listing): prefer the local entry when it has
// a real tip hash, otherwise any entry with a non-zero tip, otherwise the
// first. An unpublished branch's local tip can be all-zeros, so the remote
// entry is the only walkable anchor.
function pickBestEntry(entries: BranchEntry[]): BranchEntry | undefined {
  const localNonZero = entries.find(
    entry => entry.location === LoreBranchLocation.LOCAL && !isUnknownHash(entry.latest)
  );
  if (localNonZero) {
    return localNonZero;
  }
  return entries.find(entry => !isUnknownHash(entry.latest)) ?? entries[0];
}

// Group branch entries by a key (name or id) and reduce each group to its
// best entry, so a branch appearing as both a local and a remote listing
// resolves to one usable entry.
function bestEntriesBy(
  entries: BranchEntry[],
  keyOf: (entry: BranchEntry) => string
): Map<string, BranchEntry> {
  const groups = new Map<string, BranchEntry[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  const best = new Map<string, BranchEntry>();
  for (const [key, group] of groups) {
    const chosen = pickBestEntry(group);
    if (chosen) {
      best.set(key, chosen);
    }
  }
  return best;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The working copy's current revision — the first entry of an unqualified
// `revisionHistory` walk (no revision/branch arg). Verified live to reflect
// the working copy after a sync to an older revision. Degrades to an empty
// string (logged) rather than failing the caller. Exported for the local
// state fingerprint check alongside its use in graph assembly.
export async function getCurrentRevision(
  deps: BranchGraphDeps,
  repositoryPath: string
): Promise<string> {
  try {
    const revisions = await collectEvents(
      lore.revisionHistory({ repositoryPath }, { length: 1 }),
      LoreEventTag.REVISION_HISTORY_ENTRY,
      data => data.revision
    );
    return revisions[0] ?? '';
  } catch (error) {
    deps.emitLog(LoreLogLevel.ERROR, `Failed to resolve current revision: ${errorMessage(error)}`);
    return '';
  }
}

// Collect branchList entries reduced to the fields the graph needs. Both
// local and remote listings are kept; pickBestEntry chooses between them.
async function collectBranchEntries(
  deps: BranchGraphDeps,
  repositoryPath: string
): Promise<BranchEntry[]> {
  return collectEvents(
    lore.branchList({ repositoryPath }, {}),
    LoreEventTag.BRANCH_LIST_ENTRY,
    (data): BranchEntry => ({
      id: data.id,
      name: data.name,
      latest: data.latest,
      isCurrent: Boolean(data.isCurrent),
      location: data.location,
    }),
    error => deps.wrapError('Failed to list branches for graph', error)
  );
}

// Read the parent branch id and branch point from a BRANCH_INFO event.
async function readBranchParent(
  deps: BranchGraphDeps,
  repositoryPath: string,
  branchName: string
): Promise<{ parent: string; branchPoint: string } | null> {
  const infos = await collectEvents(
    lore.branchInfo({ repositoryPath }, { branch: branchName }),
    LoreEventTag.BRANCH_INFO,
    data => ({ parent: data.parent, branchPoint: data.branchPoint }),
    error => deps.wrapError(`Failed to read the parent of branch '${branchName}'`, error)
  );
  return infos[infos.length - 1] ?? null;
}

// Walk a lineage backward from a revision hash via parent pointers, retaining
// each entry's parent tuple for merge classification. `length` 0 walks the
// full lineage.
async function walkLineage(
  deps: BranchGraphDeps,
  repositoryPath: string,
  revision: string,
  length: number
): Promise<RawRevision[]> {
  return collectEvents(
    lore.revisionHistory({ repositoryPath }, { revision, length }),
    LoreEventTag.REVISION_HISTORY_ENTRY,
    (data): RawRevision => ({
      revision: data.revision,
      revisionNumber: data.revisionNumber,
      parent: data.parent,
    }),
    error => deps.wrapError(`Failed to walk revision lineage from '${revision}'`, error)
  );
}

// Enriches a hash-only history entry with the commit message and timestamp
// harvested from revisionInfo's METADATA events (using the FULL hash — short
// hashes are rejected by the SDK). A failure here degrades that single row to
// hash-only rather than failing the whole list.
async function enrichRevision(
  deps: BranchGraphDeps,
  repositoryPath: string,
  entry: RawRevision
): Promise<RevisionSummary> {
  const summary: RevisionSummary = {
    revision: entry.revision,
    revisionNumber: entry.revisionNumber,
  };
  let message: string | undefined;
  let timestamp: number | undefined;

  try {
    const metadata = await collectEvents(
      lore.revisionInfo({ repositoryPath }, { revision: entry.revision }),
      LoreEventTag.METADATA,
      data => data
    );
    for (const { key, value } of metadata) {
      if (key === 'message' && value.tag === LoreMetadataTag.STRING) {
        message = value.data;
      } else if (key === 'timestamp' && value.tag === LoreMetadataTag.NUMERIC) {
        timestamp = value.data;
      }
    }
  } catch (error) {
    deps.emitLog(
      LoreLogLevel.ERROR,
      `Failed to enrich revision '${entry.revision}': ${errorMessage(error)}`
    );
    return summary;
  }

  return {
    ...summary,
    ...(message !== undefined && { message }),
    ...(timestamp !== undefined && { timestamp }),
  };
}

function enrichAll(
  deps: BranchGraphDeps,
  repositoryPath: string,
  raw: RawRevision[]
): Promise<RevisionSummary[]> {
  return Promise.all(raw.map(entry => enrichRevision(deps, repositoryPath, entry)));
}

// Resolve the parent lane from branchInfo's parent id + branch point, walking
// the parent branch's tip (capped at PARENT_LANE_CAP). The raw (capped)
// entries ride along so the caller can classify merges accepted INTO the
// parent — their parent tuples are gone after enrichment. Any failure to
// resolve the parent degrades to no parent lane — it never fails the whole
// graph.
async function resolveParentLane(
  deps: BranchGraphDeps,
  repositoryPath: string,
  branchName: string,
  byId: Map<string, BranchEntry>
): Promise<{ lane: BranchGraphParentLane; raw: RawRevision[] } | undefined> {
  try {
    const info = await readBranchParent(deps, repositoryPath, branchName);
    if (!info || isUnknownHash(info.parent)) {
      return undefined;
    }
    const parentEntry = byId.get(info.parent);
    if (!parentEntry || isUnknownHash(parentEntry.latest)) {
      return undefined;
    }
    const raw = await walkLineage(deps, repositoryPath, parentEntry.latest, PARENT_LANE_CAP + 1);
    let capped = raw;
    if (raw.length > PARENT_LANE_CAP) {
      deps.emitLog(
        LoreLogLevel.WARN,
        `Parent lane for '${parentEntry.name}' capped at ${PARENT_LANE_CAP} revisions`
      );
      capped = raw.slice(0, PARENT_LANE_CAP);
    }
    const revisions = await enrichAll(deps, repositoryPath, capped);
    return {
      lane: { name: parentEntry.name, revisions, branchPoint: info.branchPoint },
      raw: capped,
    };
  } catch (error) {
    deps.emitLog(
      LoreLogLevel.ERROR,
      `Failed to resolve parent lane for '${branchName}': ${errorMessage(error)}`
    );
    return undefined;
  }
}

// Assemble the branch graph: the current branch's full lineage, the parent
// branch's lineage (when it resolves), the working-copy's current revision,
// and the child merge-revision hashes accepted from the parent.
//
// The SDK's `revisionHistory` `branch` arg is a dead end for non-current
// branches, so every lane is walked by revision hash instead: `branchList`
// entries carry each branch's tip (`latest`), and `revisionHistory` walks
// backward from a given `revision` via parent pointers (newest-first, like
// `git log`). `branchInfo` supplies the parent branch id and branch point.
export async function assembleBranchGraph(
  deps: BranchGraphDeps,
  repositoryPath: string,
  branchName: string
): Promise<BranchGraph> {
  const current = await getCurrentRevision(deps, repositoryPath);
  const entries = await collectBranchEntries(deps, repositoryPath);
  const byName = bestEntriesBy(entries, entry => entry.name);
  const byId = bestEntriesBy(entries, entry => entry.id);

  const childEntry = byName.get(branchName);
  const childName = childEntry?.name ?? branchName;
  // Full child lineage: length 0 means unlimited — the ledger scrolls.
  const childRaw =
    childEntry && !isUnknownHash(childEntry.latest)
      ? await walkLineage(deps, repositoryPath, childEntry.latest, 0)
      : [];
  const branchRevisions = await enrichAll(deps, repositoryPath, childRaw);

  const parentResolved = await resolveParentLane(deps, repositoryPath, branchName, byId);
  const parent = parentResolved?.lane;

  // A child revision is a merge from the parent when its other-parent
  // (parent[1], non-zero on merge revisions) sits on the parent lineage.
  // Each pair carries the merge revision and its true parent-lineage
  // source, so the constellation view can anchor the connector to it.
  const parentHashes = new Set((parent?.revisions ?? []).map(revision => revision.revision));
  const mergesFromParent = childRaw
    .filter(entry => !isUnknownHash(entry.parent[1]) && parentHashes.has(entry.parent[1]))
    .map(entry => ({ child: entry.revision, parentSource: entry.parent[1] }));

  // Symmetrically, a parent revision is a merge accepted UP from the child
  // when its other-parent sits on the child lineage — the constellation
  // view anchors the rising connector to that child source node.
  const childHashes = new Set(childRaw.map(entry => entry.revision));
  const mergesToParent = (parentResolved?.raw ?? [])
    .filter(entry => !isUnknownHash(entry.parent[1]) && childHashes.has(entry.parent[1]))
    .map(entry => ({ parent: entry.revision, childSource: entry.parent[1] }));

  return {
    current,
    branch: { name: childName, revisions: branchRevisions },
    ...(parent ? { parent } : {}),
    mergesFromParent,
    mergesToParent,
  };
}
