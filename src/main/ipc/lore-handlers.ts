import * as path from 'node:path';
import type { LoreRepositoryService } from '../services/lore-repository';
import { handleRequest, handleResult } from './result-helpers';
import {
  LoreRepositoryPathArgsSchema,
  LoreLocalPathArgsSchema,
  LoreListRemoteArgsSchema,
  LoreCloneArgsSchema,
  LoreSyncArgsSchema,
  LoreFilePathsArgsSchema,
  LoreCommitArgsSchema,
  LoreBranchInfoArgsSchema,
  LoreBranchGraphArgsSchema,
  RevisionsToLandRequestSchema,
} from './validators';
import type { MainLogger } from './logger';

function registerLoreFileHandlers(
  log: MainLogger,
  loreRepositoryService: LoreRepositoryService
): void {
  handleResult(log, 'lore:files:status', LoreRepositoryPathArgsSchema, repositoryPath =>
    loreRepositoryService.getFileStatus(repositoryPath)
  );

  // Stage/unstage take repo-relative paths (as reported by lore:files:status)
  // and join them against the repository path here in the main process.
  handleResult(log, 'lore:files:stage', LoreFilePathsArgsSchema, (repositoryPath, filePaths) =>
    loreRepositoryService.stageFiles(
      repositoryPath,
      filePaths.map(filePath => path.join(repositoryPath, filePath))
    )
  );

  handleResult(log, 'lore:files:unstage', LoreFilePathsArgsSchema, (repositoryPath, filePaths) =>
    loreRepositoryService.unstageFiles(
      repositoryPath,
      filePaths.map(filePath => path.join(repositoryPath, filePath))
    )
  );
}

// Commit and push are separate operations: commit never pushes, and push
// never commits — kept as distinct handlers so the renderer can trigger
// each independently.
function registerLoreCommitHandlers(
  log: MainLogger,
  loreRepositoryService: LoreRepositoryService
): void {
  handleResult(log, 'lore:repository:commit', LoreCommitArgsSchema, (repositoryPath, message) =>
    loreRepositoryService.commit(repositoryPath, message)
  );

  handleResult(log, 'lore:repository:push', LoreRepositoryPathArgsSchema, repositoryPath =>
    loreRepositoryService.push(repositoryPath)
  );
}

// Server push-notification subscriptions: the renderer opts a repository in
// or out; delivery happens over the one-way 'lore:notification' channel
// wired in main/index.ts.
function registerLoreNotificationHandlers(
  log: MainLogger,
  loreRepositoryService: LoreRepositoryService
): void {
  handleResult(log, 'lore:notifications:subscribe', LoreRepositoryPathArgsSchema, repositoryPath =>
    loreRepositoryService.subscribeNotifications(repositoryPath)
  );

  handleResult(
    log,
    'lore:notifications:unsubscribe',
    LoreRepositoryPathArgsSchema,
    repositoryPath => loreRepositoryService.unsubscribeNotifications(repositoryPath)
  );
}

export function registerLoreHandlers(
  log: MainLogger,
  loreRepositoryService: LoreRepositoryService
): void {
  registerLoreFileHandlers(log, loreRepositoryService);
  registerLoreCommitHandlers(log, loreRepositoryService);
  registerLoreNotificationHandlers(log, loreRepositoryService);

  handleResult(log, 'lore:repository:list-remote', LoreListRemoteArgsSchema, serverAddress =>
    loreRepositoryService.listRemoteRepositories(serverAddress)
  );

  handleResult(log, 'lore:branches:list', LoreRepositoryPathArgsSchema, repositoryPath =>
    loreRepositoryService.listBranches(repositoryPath)
  );

  handleResult(log, 'lore:repository:status', LoreLocalPathArgsSchema, localPath =>
    loreRepositoryService.checkRepositoryStatus(localPath)
  );

  // Normalize the target path to use OS-specific separators
  handleResult(log, 'lore:repository:clone', LoreCloneArgsSchema, (repositoryUrl, localPath) =>
    loreRepositoryService.cloneRepository(repositoryUrl, path.normalize(localPath))
  );

  handleResult(
    log,
    'lore:repository:sync',
    LoreSyncArgsSchema,
    (repositoryPath, targetBranch?, options?) =>
      loreRepositoryService.syncRepository(repositoryPath, targetBranch, options)
  );

  // The local state fingerprint: the working copy's current revision hash.
  // Polled cheaply by the renderer to catch mutations made outside the app
  // (CLI commits, syncs, branch switches) that no server notification covers.
  handleResult(log, 'lore:currentRevision', LoreRepositoryPathArgsSchema, repositoryPath =>
    loreRepositoryService.getCurrentRevision(repositoryPath)
  );

  handleResult(log, 'lore:branchInfo', LoreBranchInfoArgsSchema, ({ repositoryPath, branch }) =>
    loreRepositoryService.getBranchDivergence(repositoryPath, branch)
  );

  handleResult(log, 'lore:branchGraph', LoreBranchGraphArgsSchema, ({ repositoryPath, branch }) =>
    loreRepositoryService.getBranchGraph(repositoryPath, branch)
  );

  // The card's merge-entry gate: whether the branch carries revisions the
  // target lacks — the same ancestry predicate MergeService lands on.
  handleRequest(
    log,
    'lore:revisionsToLand',
    RevisionsToLandRequestSchema,
    ({ repositoryPath, sourceBranch, targetBranch }) =>
      loreRepositoryService.hasRevisionsToLand(repositoryPath, sourceBranch, targetBranch)
  );
}
