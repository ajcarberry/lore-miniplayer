import { useCallback, useMemo, useState } from 'react';
import type { FileStagingState } from './useFileStaging';
import type { WorkingSetFile } from '../components/WorkingSet';

export interface WorkingSetFlowState {
  readonly workingSetFiles: WorkingSetFile[];
  readonly workingSetOpen: boolean;
  readonly toggleWorkingSetOpen: () => void;
  readonly toggleFile: (path: string) => void;
  readonly commitDialogOpened: boolean;
  // Commit opens the in-card dialog; with nothing staged it instead expands
  // the working set as a nudge to stage something first.
  readonly openCommitDialog: () => void;
  readonly closeCommitDialog: () => void;
  readonly submitCommit: () => Promise<void>;
}

// Derives the WorkingSet/CommitDialog UI state from the single useFileStaging
// instance MiniPlayer owns: the transfer-list-to-file-row mapping, a
// per-file toggle wrapping applyTransfer, and the open/close/submit flow for
// the commit dialog. `onCommitted` fires after a successful commit (used to
// refresh branch divergence, which typically flips to "out of sync").
export function useWorkingSet(
  fileStaging: FileStagingState,
  onCommitted?: () => void
): WorkingSetFlowState {
  const [workingSetOpen, setWorkingSetOpen] = useState(false);
  const [commitDialogOpened, setCommitDialogOpened] = useState(false);
  const [unstagedFiles, stagedFiles] = fileStaging.transferListData;

  const workingSetFiles = useMemo<WorkingSetFile[]>(
    () => [
      ...stagedFiles.map(file => ({
        path: file.value,
        kind: (file.isUntracked ? 'add' : 'edit') as WorkingSetFile['kind'],
        staged: true,
      })),
      ...unstagedFiles.map(file => ({
        path: file.value,
        kind: (file.isUntracked ? 'add' : 'edit') as WorkingSetFile['kind'],
        staged: false,
      })),
    ],
    [stagedFiles, unstagedFiles]
  );

  // Wraps applyTransfer with a lookup so WorkingSet rows can toggle a single
  // file by path without callers reconstructing both transfer-list halves.
  const toggleFile = useCallback(
    (path: string): void => {
      const staged = stagedFiles.find(file => file.value === path);
      if (staged) {
        void fileStaging.applyTransfer([
          [...unstagedFiles, staged],
          stagedFiles.filter(file => file.value !== path),
        ]);
        return;
      }
      const unstaged = unstagedFiles.find(file => file.value === path);
      if (unstaged) {
        void fileStaging.applyTransfer([
          unstagedFiles.filter(file => file.value !== path),
          [...stagedFiles, unstaged],
        ]);
      }
    },
    [fileStaging, stagedFiles, unstagedFiles]
  );

  const openCommitDialog = useCallback((): void => {
    if (stagedFiles.length === 0) {
      setWorkingSetOpen(true);
      return;
    }
    setCommitDialogOpened(true);
  }, [stagedFiles]);

  const submitCommit = useCallback(async (): Promise<void> => {
    if (await fileStaging.commit()) {
      setCommitDialogOpened(false);
      onCommitted?.();
    }
  }, [fileStaging, onCommitted]);

  return {
    workingSetFiles,
    workingSetOpen,
    toggleWorkingSetOpen: () => setWorkingSetOpen(open => !open),
    toggleFile,
    commitDialogOpened,
    openCommitDialog,
    closeCommitDialog: () => setCommitDialogOpened(false),
    submitCommit,
  };
}
