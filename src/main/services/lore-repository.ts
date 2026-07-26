import { lore } from '@lore-vcs/sdk';
import {
  LoreBranchLocation,
  LoreEventTag,
  LoreFileAction,
  LoreNodeType,
} from '@lore-vcs/sdk/types/enums';
import type { LoreGlobalArgs, LoreRevisionSyncArgs } from '@lore-vcs/sdk/types/args';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  LoreBranch,
  LoreSyncOptions,
  LoreFileStatus,
  LoreFileStatusGroup,
  BranchDivergence,
  BranchGraph,
  CloneProgress,
  RepositoryNotification,
  RepositoryNotificationKind,
} from '../../shared/types';
import type { LoreEventFFITyped } from '@lore-vcs/sdk/types/events';
import { assembleBranchGraph, getCurrentRevision, isUnknownHash } from './branch-graph';
import { resolveRepositoryIdentity, type RepositoryIdentity } from './lore-repository-info';
import { OperationError, operationHelpers } from './lore-operation';
import {
  readHasRevisionsToLand,
  readMergeTargetRevision,
  readWorkspaceRevisionStatus,
  type WorkspaceRevisionStatus,
} from './lore-status';

// Re-exported so consumers keep importing the type from the owning service.

// How far back to walk local revision history when looking for the
// remote's latest hash to determine ahead-vs-behindOrDiverged direction.
const DIVERGENCE_HISTORY_WALK_LENGTH = 100;

// Directory marker identifying a Lore working copy
const REPOSITORY_MARKERS = ['.lore'] as const;

// The server does not flag a default branch in branch listings; by
// convention the default branch is named `main`
const DEFAULT_BRANCH_NAME = 'main';

// Pure derivation of divergence state from BRANCH_INFO's latest/latestRemote
// hashes, plus a locally-walked list of ancestor hashes on the current
// branch (see getBranchDivergence). When the hashes differ, `latestRemote`
// being present in `localRevisionHashes` means local has moved past it
// (ahead); otherwise the remote has moved on and the user's next action is
// to sync (behindOrDiverged, covering both pure-behind and true-divergence).
export function deriveDivergence(
  latest: string,
  latestRemote: string,
  localRevisionHashes: readonly string[] = []
): BranchDivergence['state'] {
  if (isUnknownHash(latest) || isUnknownHash(latestRemote)) {
    return 'unknown';
  }
  if (latest === latestRemote) {
    return 'inSync';
  }
  return localRevisionHashes.includes(latestRemote) ? 'ahead' : 'behindOrDiverged';
}

// Percent complete for a clone from the SDK's progress counts: byte ratio
// once discovery has reported totals, file ratio before that.
export function cloneProgressPercent(count: {
  bytesTransferred: number;
  bytesTotal: number;
  fileComplete: number;
  fileCount: number;
}): number {
  const ratio =
    count.bytesTotal > 0
      ? count.bytesTransferred / count.bytesTotal
      : count.fileCount > 0
        ? count.fileComplete / count.fileCount
        : 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

// Push-notification event tags mapped to the kinds the app reacts to.
const NOTIFICATION_KIND_BY_TAG: Partial<Record<LoreEventTag, RepositoryNotificationKind>> = {
  [LoreEventTag.NOTIFICATION_BRANCH_PUSHED]: 'branchPushed',
  [LoreEventTag.NOTIFICATION_BRANCH_CREATED]: 'branchCreated',
  [LoreEventTag.NOTIFICATION_BRANCH_DELETED]: 'branchDeleted',
};

export class LoreOperationError extends OperationError {
  constructor(message: string) {
    super(message);
    this.name = 'LoreOperationError';
  }
}

// Shared run/collect/toOperationError scaffold (see ./lore-operation), typed
// to this service's error class.
const { toOperationError, run, collect } = operationHelpers(LoreOperationError);

export class LoreRepositoryService extends EventEmitter {
  // Repository paths with an active notification subscription. Guards
  // against double-subscribing the same repository.
  private readonly notificationSubscriptions = new Set<string>();

  // Subscribe to the server's push notifications for a repository. The
  // SDK resolves the subscribe call as soon as the server acknowledges
  // it, then keeps delivering notification events through the same
  // callback until notificationUnsubscribe (verified against a live
  // server). Recognized events are re-emitted as 'notification' with
  // `RepositoryNotification` payloads.
  async subscribeNotifications(repositoryPath: string): Promise<void> {
    if (this.notificationSubscriptions.has(repositoryPath)) {
      return;
    }
    this.notificationSubscriptions.add(repositoryPath);
    try {
      await lore
        .notificationSubscribe({ repositoryPath }, {})
        .callback(event => {
          const kind = NOTIFICATION_KIND_BY_TAG[event.tag];
          if (kind) {
            this.emit('notification', this.toNotification(repositoryPath, kind, event));
          }
        })
        .waitAsync();
    } catch (error) {
      this.notificationSubscriptions.delete(repositoryPath);
      throw toOperationError('Failed to subscribe to repository notifications', error);
    }
  }

  // Builds the RepositoryNotification payload for a recognized event tag.
  // branchPushed carries the pushing user's id (attribution toast, spec
  // "Supporting signals"); branchCreated/branchDeleted carry none.
  private toNotification(
    repositoryPath: string,
    kind: RepositoryNotificationKind,
    event: LoreEventFFITyped<LoreEventTag>
  ): RepositoryNotification {
    if (event.tag === LoreEventTag.NOTIFICATION_BRANCH_PUSHED) {
      const { userId } = (
        event as LoreEventFFITyped<LoreEventTag.NOTIFICATION_BRANCH_PUSHED>
      ).clone().data;
      return { repositoryPath, kind, ...(userId ? { userId } : {}) };
    }
    return { repositoryPath, kind };
  }

  // Release the notification stream for a repository; a no-op when the
  // path has no active subscription.
  async unsubscribeNotifications(repositoryPath: string): Promise<void> {
    if (!this.notificationSubscriptions.has(repositoryPath)) {
      return;
    }
    await run(
      lore.notificationUnsubscribe({ repositoryPath }, {}),
      'Failed to unsubscribe from repository notifications'
    );
    this.notificationSubscriptions.delete(repositoryPath);
  }

  // Resolve a checkout's true Lore identity (composed url + stable id) from its
  // `.lore/` config. Delegates to ./lore-repository-info (extracted for the
  // max-lines limit); throws on SDK failure so callers can wrap + degrade.
  async resolveRepositoryIdentity(repositoryPath: string): Promise<RepositoryIdentity | undefined> {
    return resolveRepositoryIdentity(repositoryPath, toOperationError);
  }

  async listBranches(repositoryPath: string): Promise<LoreBranch[]> {
    const entries = await collect(
      lore.branchList({ repositoryPath }, {}),
      LoreEventTag.BRANCH_LIST_ENTRY,
      data => ({ name: data.name, location: data.location, isCurrent: Boolean(data.isCurrent) }),
      'Failed to list branches'
    );

    // A single listing reports local and remote branches; the same branch
    // can appear from both locations, in which case the local entry wins
    const branches = new Map<string, LoreBranch>();
    for (const entry of entries) {
      if (!branches.has(entry.name) || entry.location === LoreBranchLocation.LOCAL) {
        branches.set(entry.name, {
          name: entry.name,
          isDefault: entry.name === DEFAULT_BRANCH_NAME,
          isCurrent: entry.isCurrent,
        });
      }
    }

    return [...branches.values()];
  }

  // Get branch divergence - latest local vs latest remote revision hashes,
  // with direction. When the hashes differ, a follow-up walk of local
  // revision history checks whether the remote's hash is a known local
  // ancestor (ahead) or not (behindOrDiverged) — see deriveDivergence.
  async getBranchDivergence(repositoryPath: string, branchName: string): Promise<BranchDivergence> {
    const infoEntries = await collect(
      lore.branchInfo({ repositoryPath }, { branch: branchName }),
      LoreEventTag.BRANCH_INFO,
      data => ({ latest: data.latest, latestRemote: data.latestRemote }),
      `Failed to get branch divergence for '${branchName}'`
    );
    const info = infoEntries[infoEntries.length - 1];
    const latest = info?.latest ?? '';
    const latestRemote = info?.latestRemote ?? '';

    if (isUnknownHash(latest) || isUnknownHash(latestRemote) || latest === latestRemote) {
      return { state: deriveDivergence(latest, latestRemote), latest, latestRemote };
    }

    // Walk local history looking for latestRemote. `onlyBranch: false` is
    // used deliberately — the remote head may sit on a merge lineage, and
    // restricting the walk to the current branch risks stopping short of it.
    const localRevisionHashes = await collect(
      lore.revisionHistory(
        { repositoryPath },
        { branch: branchName, length: DIVERGENCE_HISTORY_WALK_LENGTH, onlyBranch: false }
      ),
      LoreEventTag.REVISION_HISTORY_ENTRY,
      data => data.revision,
      `Failed to get branch divergence for '${branchName}'`
    );

    return {
      state: deriveDivergence(latest, latestRemote, localRevisionHashes),
      latest,
      latestRemote,
    };
  }

  // The current checkout's branch, revision, and remote divergence from ONE
  // cheap repositoryStatus({ revisionOnly: true }) call (C25/C27). The
  // collection + derivation lives in ./lore-status.
  async getWorkspaceRevisionStatus(
    repositoryPath: string
  ): Promise<WorkspaceRevisionStatus | undefined> {
    return readWorkspaceRevisionStatus(repositoryPath, error =>
      toOperationError('Failed to read workspace revision status', error)
    );
  }

  // The revision a merge toward `branch` addresses — its remote tip when known
  // (see readMergeTargetRevision). '' when the branch reports nothing.
  async getMergeTargetRevision(repositoryPath: string, branch: string): Promise<string> {
    return readMergeTargetRevision(repositoryPath, branch, error =>
      toOperationError(`Failed to read the tip of branch '${branch}'`, error)
    );
  }

  // Whether `sourceBranch` still carries revisions `targetBranch` lacks — what
  // gates the card's Merge entry and the merge workflow's landing (see
  // readHasRevisionsToLand).
  async hasRevisionsToLand(
    repositoryPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<boolean> {
    return readHasRevisionsToLand(repositoryPath, sourceBranch, targetBranch, error =>
      toOperationError(`Failed to compare '${sourceBranch}' against '${targetBranch}'`, error)
    );
  }

  // Assemble the branch graph for a branch — the current branch's full
  // lineage, the parent branch's lineage (when it resolves), the working
  // copy's current revision, and the merges accepted from the parent. The
  // assembly logic lives in ./branch-graph; this passes it the SDK-event
  // forwarding, logging, and error-wrapping it needs from this service.
  async getBranchGraph(repositoryPath: string, branchName: string): Promise<BranchGraph> {
    return assembleBranchGraph(
      {
        emitLog: (level, message) => this.emit('log', { level, message }),
        wrapError: toOperationError,
      },
      repositoryPath,
      branchName
    );
  }

  // The working copy's current revision hash — the local state fingerprint.
  // A cheap local DB read; degrades to '' (logged) so a failed tick skips
  // rather than surfaces.
  async getCurrentRevision(repositoryPath: string): Promise<string> {
    return getCurrentRevision(
      {
        emitLog: (level, message) => this.emit('log', { level, message }),
        wrapError: toOperationError,
      },
      repositoryPath
    );
  }

  async checkRepositoryStatus(
    localPath: string
  ): Promise<{ exists: boolean; isLoreRepo: boolean }> {
    try {
      const stats = await fs.stat(localPath);
      if (!stats.isDirectory()) {
        return { exists: true, isLoreRepo: false };
      }

      for (const marker of REPOSITORY_MARKERS) {
        try {
          await fs.access(path.join(localPath, marker));
          return { exists: true, isLoreRepo: true };
        } catch {
          // Marker not present; try the next one
        }
      }
      return { exists: true, isLoreRepo: false };
    } catch {
      return { exists: false, isLoreRepo: false };
    }
  }

  // Clone a repository, re-emitting the SDK's streamed progress counts as
  // 'cloneProgress' events with a derived percent.
  async cloneRepository(repositoryUrl: string, localPath: string): Promise<void> {
    await run(
      lore.repositoryClone({ repositoryPath: localPath }, { repositoryUrl }).callback(event => {
        if (event.tag === LoreEventTag.REPOSITORY_CLONE_PROGRESS) {
          const { count } = (
            event as LoreEventFFITyped<LoreEventTag.REPOSITORY_CLONE_PROGRESS>
          ).clone().data;
          const progress: CloneProgress = { localPath, percent: cloneProgressPercent(count) };
          this.emit('cloneProgress', progress);
        }
      }),
      `Failed to clone repository '${repositoryUrl}'`
    );
  }

  // List remote repositories available on the given server
  async listRemoteRepositories(serverAddress: string): Promise<{ name: string; url: string }[]> {
    // Server addresses may carry a scheme (`lore://` for plaintext local
    // servers, `lores://` for TLS); a bare host is passed through and the
    // SDK defaults it to TLS. Any repository path segment is stripped.
    const match = /^([a-z][a-z0-9+.-]*:\/\/)?([^/]*)/i.exec(serverAddress.trim());
    const scheme = match?.[1] ?? '';
    const host = match?.[2] ?? '';
    if (!host) {
      throw new Error('No server address provided');
    }
    const serverUrl = `${scheme}${host}`;

    return collect(
      lore.repositoryList({}, { url: serverUrl }),
      LoreEventTag.REPOSITORY_LIST_ENTRY,
      data => (data.name ? { name: data.name, url: `${serverUrl}/${data.name}` } : undefined),
      'Failed to list remote repositories'
    );
  }

  // Switch to a different branch
  async switchBranch(repositoryPath: string, branchName: string): Promise<void> {
    await run(
      lore.branchSwitch({ repositoryPath }, { branch: branchName }),
      `Failed to switch to branch '${branchName}'`
    );
  }

  // Sync repository - pull latest changes, optionally switching branch first
  async syncRepository(
    repositoryPath: string,
    targetBranch?: string,
    options?: LoreSyncOptions
  ): Promise<void> {
    // If a target branch is specified, switch to it first
    if (targetBranch) {
      await this.switchBranch(repositoryPath, targetBranch);
    }

    const globals: LoreGlobalArgs = {
      repositoryPath,
      ...(options?.force && { force: true }),
    };
    const args: LoreRevisionSyncArgs = {
      ...(options?.revision && { revision: options.revision }),
      ...(options?.reset && { reset: options.reset }),
      ...(options?.forwardChanges && { forwardChanges: options.forwardChanges }),
    };

    await run(lore.revisionSync(globals, args), 'Failed to sync repository');
  }

  // Get file status - returns staged, untracked, and unstaged files
  async getFileStatus(repositoryPath: string): Promise<LoreFileStatusGroup> {
    const files = await collect<LoreEventTag.REPOSITORY_STATUS_FILE, LoreFileStatus>(
      lore.repositoryStatus({ repositoryPath }, { staged: true, scan: true }),
      LoreEventTag.REPOSITORY_STATUS_FILE,
      data => {
        if (data.type === LoreNodeType.DIRECTORY) {
          return undefined;
        }
        return {
          path: data.path,
          isUntracked: data.action === LoreFileAction.ADD,
          isStaged: Boolean(data.flagStaged),
          conflict: Boolean(data.flagConflict),
          conflictUnresolved: Boolean(data.flagConflictUnresolved),
          conflictAutomerged: Boolean(data.flagConflictAutomerged),
          conflictMine: Boolean(data.flagConflictMine),
          conflictTheirs: Boolean(data.flagConflictTheirs),
        };
      },
      'Failed to get file status'
    );

    // Categorize files into groups
    const untracked: LoreFileStatus[] = [];
    const unstaged: LoreFileStatus[] = [];
    const staged: LoreFileStatus[] = [];

    for (const file of files) {
      if (file.isStaged) {
        staged.push(file);
      } else if (file.isUntracked) {
        untracked.push(file);
      } else {
        unstaged.push(file);
      }
    }

    return { untracked, unstaged, staged };
  }

  // Stage files
  async stageFiles(repositoryPath: string, filePaths: string[]): Promise<void> {
    await run(lore.fileStage({ repositoryPath }, { paths: filePaths }), 'Failed to stage files');
  }

  // Unstage files
  async unstageFiles(repositoryPath: string, filePaths: string[]): Promise<void> {
    await run(
      lore.fileUnstage({ repositoryPath }, { paths: filePaths }),
      'Failed to unstage files'
    );
  }

  // Commit staged changes (does not push). Returns the committed revision
  // hash, streamed by the commit itself (REVISION_COMMIT_REVISION) — no
  // follow-up history read, and no race with a moving tip. '' when the SDK
  // streamed no revision event.
  async commit(repositoryPath: string, message: string): Promise<string> {
    const revisions = await collect(
      lore.revisionCommit({ repositoryPath }, { message }),
      LoreEventTag.REVISION_COMMIT_REVISION,
      data => data.revision,
      'Failed to commit changes'
    );
    return revisions[revisions.length - 1] ?? '';
  }

  // Push committed changes (does not commit)
  async push(repositoryPath: string): Promise<void> {
    await run(lore.branchPush({ repositoryPath }, {}), 'Failed to push changes');
  }
}
