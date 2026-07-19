import { useCallback, useEffect, useRef, useState } from 'react';
import { CloneProgressSchema } from '../../shared/schemas';
import type { Repository } from '../../shared/types';
import { validateRepositoryName } from '../utils/repository-name';

export interface SubmissionInput {
  readonly mode: 'new' | 'existing';
  readonly friendlyName: string;
  readonly selectedRepoUrl: string;
  readonly baseDirectory: string;
}

export interface RepositorySubmissionState {
  readonly isCloning: boolean;
  readonly cloneProgress: number;
  readonly cloneComplete: boolean;
  readonly error: string | null;
  readonly setError: (error: string | null) => void;
  readonly submit: (input: SubmissionInput) => Promise<void>;
}

interface SubmissionDeps {
  readonly onAdd: (repository: Repository) => void;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

// Creates the repository record and clones it (for new repositories) with
// real streamed progress, then hands the result back to the caller
export function useRepositorySubmission(deps: SubmissionDeps): RepositorySubmissionState {
  const { onAdd, onClose, onDone } = deps;
  const [isCloning, setIsCloning] = useState(false);
  const [cloneProgress, setCloneProgress] = useState(0);
  const [cloneComplete, setCloneComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The completion pause below outlives fast modal closes; cancel it on
  // unmount so no callback or setState fires against an unmounted tree.
  const completionTimer = useRef<number | null>(null);
  useEffect(
    () => (): void => {
      if (completionTimer.current !== null) {
        window.clearTimeout(completionTimer.current);
      }
    },
    []
  );

  const runClone = useCallback(async (repositoryUrl: string, repositoryPath: string) => {
    // Real progress: the main process re-emits the SDK's clone PROGRESS
    // events over a push channel; payloads are Zod-validated and filtered
    // to this clone's destination path.
    const unsubscribe = window.electronAPI.lore.repository.onCloneProgress(payload => {
      const parsed = CloneProgressSchema.safeParse(payload);
      if (parsed.success && parsed.data.localPath === repositoryPath) {
        setCloneProgress(parsed.data.percent);
      }
    });
    try {
      const result = await window.electronAPI.lore.repository.clone(repositoryUrl, repositoryPath);
      if (!result.success) {
        throw new Error(result.error);
      }
    } finally {
      unsubscribe();
    }
  }, []);

  const submit = useCallback(
    async (input: SubmissionInput): Promise<void> => {
      const { mode, friendlyName, selectedRepoUrl, baseDirectory } = input;
      const nameError = validateRepositoryName(friendlyName);
      if (nameError || !baseDirectory) {
        setError(nameError || 'Please fill all required fields');
        return;
      }
      if (mode === 'new' && !selectedRepoUrl) {
        setError('Please select a repository');
        return;
      }

      setIsCloning(true);
      setCloneProgress(0);
      setCloneComplete(false);
      setError(null);

      try {
        let repositoryPath = baseDirectory;
        if (mode === 'new') {
          const joinResult = await window.electronAPI.path.join([baseDirectory, friendlyName]);
          if (!joinResult.success) {
            setError(joinResult.error);
            setIsCloning(false);
            return;
          }
          repositoryPath = joinResult.data;
        }

        const createResult = await window.electronAPI.repository.create({
          name: friendlyName,
          url: mode === 'existing' ? 'local://existing' : selectedRepoUrl,
          localPath: repositoryPath,
        });
        if (!createResult.success) {
          throw new Error(createResult.error);
        }
        const newRepo = createResult.data;

        if (mode === 'new') {
          try {
            await runClone(selectedRepoUrl, repositoryPath);
          } catch (cloneError) {
            // The record was created before the clone ran; remove it so a
            // failed clone doesn't leave a phantom repository behind.
            await window.electronAPI.repository.delete(newRepo.id);
            throw cloneError;
          }
        }
        setCloneProgress(100);
        setCloneComplete(true);

        // Wait briefly to show completion
        completionTimer.current = window.setTimeout(() => {
          completionTimer.current = null;
          onAdd(newRepo);
          onClose();
          onDone();
          setCloneProgress(0);
          setCloneComplete(false);
          setIsCloning(false);
        }, 500);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to clone repository');
        setIsCloning(false);
        setCloneProgress(0);
        setCloneComplete(false);
      }
    },
    [runClone, onAdd, onClose, onDone]
  );

  return { isCloning, cloneProgress, cloneComplete, error, setError, submit };
}
