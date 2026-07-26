import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LoreFileStatus, Repository } from '../../shared/types';
import { logError } from '../utils/logging';
import { notifyError, notifySuccess } from '../utils/notify';

export interface FileItem {
  readonly value: string;
  readonly label: string;
  readonly isUntracked: boolean;
  // The SDK's conflict flag, carried through for the working-set conflict
  // row — the checkbox becomes a warning and staging is blocked.
  readonly conflictUnresolved: boolean;
}

export type TransferListData = [FileItem[], FileItem[]];

interface FileData {
  readonly repoId: string;
  readonly lists: TransferListData;
}

export interface FileStagingState {
  readonly transferListData: TransferListData;
  readonly isLoadingFiles: boolean;
  readonly commitMessage: string;
  readonly setCommitMessage: (message: string) => void;
  readonly isCommitting: boolean;
  readonly isPushing: boolean;
  readonly applyTransfer: (next: TransferListData) => Promise<void>;
  // Returns whether the commit succeeded, so callers can close their dialog.
  // Commits only — it never pushes.
  readonly commit: () => Promise<boolean>;
  // Returns whether the push succeeded. Independent of commit.
  readonly push: () => Promise<boolean>;
}

const POLL_INTERVAL_MS = 3000;

const toItem = (file: LoreFileStatus): FileItem => ({
  value: file.path,
  label: file.path,
  isUntracked: file.isUntracked,
  conflictUnresolved: file.conflictUnresolved === true,
});

async function fetchLists(repo: Repository): Promise<TransferListData> {
  const result = await window.electronAPI.lore.files.getStatus(repo.localPath);
  if (!result.success) {
    return [[], []];
  }
  const unstaged = [...result.data.untracked, ...result.data.unstaged]
    .map(toItem)
    .sort((a, b) => a.value.localeCompare(b.value));
  const staged = result.data.staged.map(toItem).sort((a, b) => a.value.localeCompare(b.value));
  return [unstaged, staged];
}

// Drives the commit view: loads and polls the working-directory status,
// applies stage/unstage moves, and commits staged files. Loading state is
// derived from the repository id so the effect stays free of synchronous
// setState.
export function useFileStaging(selectedRepo: Repository | null): FileStagingState {
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!selectedRepo) {
      return;
    }
    try {
      const lists = await fetchLists(selectedRepo);
      setFileData({ repoId: selectedRepo.id, lists });
    } catch (error) {
      logError('Failed to load file status', {
        error,
        localPath: selectedRepo.localPath,
        operation: 'useFileStaging',
      });
    }
  }, [selectedRepo]);

  useEffect(() => {
    if (!selectedRepo) {
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const lists = await fetchLists(selectedRepo);
        if (!cancelled) {
          setFileData({ repoId: selectedRepo.id, lists });
        }
      } catch (error) {
        logError('Failed to load file status', {
          error,
          localPath: selectedRepo.localPath,
          operation: 'useFileStaging',
        });
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return (): void => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedRepo]);

  const transferListData: TransferListData = useMemo(
    () => (fileData?.repoId === selectedRepo?.id ? (fileData?.lists ?? [[], []]) : [[], []]),
    [fileData, selectedRepo]
  );

  // Stage/unstage send the repo-relative paths straight through; the main
  // process joins them against the repository path.
  const moveFiles = useCallback(
    async (repo: Repository, paths: string[], direction: 'stage' | 'unstage'): Promise<void> => {
      const result =
        direction === 'stage'
          ? await window.electronAPI.lore.files.stage(repo.localPath, paths)
          : await window.electronAPI.lore.files.unstage(repo.localPath, paths);
      if (!result.success) {
        throw new Error(result.error);
      }
    },
    []
  );

  // Applies a transfer-list change by staging/unstaging the moved files,
  // with an optimistic UI update that is reconciled by a reload
  const applyTransfer = useCallback(
    async (next: TransferListData): Promise<void> => {
      if (!selectedRepo) {
        return;
      }
      const [nextUnstaged, nextStaged] = next;
      const [prevUnstaged, prevStaged] = transferListData;
      const newlyStaged = nextStaged
        .filter(file => !prevStaged.some(f => f.value === file.value))
        .map(f => f.value);
      const newlyUnstaged = nextUnstaged
        .filter(file => !prevUnstaged.some(f => f.value === file.value))
        .map(f => f.value);

      setFileData({ repoId: selectedRepo.id, lists: next });
      try {
        if (newlyStaged.length > 0) {
          await moveFiles(selectedRepo, newlyStaged, 'stage');
        }
        if (newlyUnstaged.length > 0) {
          await moveFiles(selectedRepo, newlyUnstaged, 'unstage');
        }
      } catch (error) {
        logError('Failed to stage/unstage files', {
          error,
          newlyStaged,
          newlyUnstaged,
          operation: 'useFileStaging',
        });
        notifyError('Staging Failed', error);
      } finally {
        await reload();
      }
    },
    [selectedRepo, transferListData, moveFiles, reload]
  );

  const commit = useCallback(async (): Promise<boolean> => {
    if (!selectedRepo || !commitMessage.trim()) {
      return false;
    }
    setIsCommitting(true);
    try {
      const result = await window.electronAPI.lore.repository.commit(
        selectedRepo.localPath,
        commitMessage
      );
      if (!result.success) {
        notifyError('Commit Failed', result.error);
        return false;
      }
      setCommitMessage('');
      await reload();
      notifySuccess('Success', 'Changes committed');
      return true;
    } catch (error) {
      logError('Failed to commit', {
        error,
        localPath: selectedRepo.localPath,
        operation: 'useFileStaging',
      });
      notifyError('Commit Failed', error);
      return false;
    } finally {
      setIsCommitting(false);
    }
  }, [selectedRepo, commitMessage, reload]);

  const push = useCallback(async (): Promise<boolean> => {
    if (!selectedRepo) {
      return false;
    }
    setIsPushing(true);
    try {
      const result = await window.electronAPI.lore.repository.push(selectedRepo.localPath);
      if (!result.success) {
        notifyError('Push Failed', result.error);
        return false;
      }
      notifySuccess('Success', 'Pushed to server');
      return true;
    } catch (error) {
      logError('Failed to push', {
        error,
        localPath: selectedRepo.localPath,
        operation: 'useFileStaging',
      });
      notifyError('Push Failed', error);
      return false;
    } finally {
      setIsPushing(false);
    }
  }, [selectedRepo]);

  return {
    transferListData,
    isLoadingFiles: selectedRepo !== null && fileData?.repoId !== selectedRepo.id,
    commitMessage,
    setCommitMessage,
    isCommitting,
    isPushing,
    applyTransfer,
    commit,
    push,
  };
}
