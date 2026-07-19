import { act, renderHook } from '@testing-library/react';
import { useRepositorySubmission } from '../../../src/renderer/hooks/useRepositorySubmission';
import type { SubmissionInput } from '../../../src/renderer/hooks/useRepositorySubmission';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeRepository } from '../../mocks/repository-fixture';

const cloneInput: SubmissionInput = {
  mode: 'new',
  friendlyName: 'RepoA',
  selectedRepoUrl: 'lore.example.com/RepoA',
  baseDirectory: '/repos',
};

const createdRepo = makeRepository({
  name: 'RepoA',
  url: 'lore.example.com/RepoA',
  localPath: '/repos/RepoA',
});

describe('useRepositorySubmission', () => {
  let api: ReturnType<typeof installMockElectronAPI>;
  const deps = { onAdd: jest.fn(), onClose: jest.fn(), onDone: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    api = installMockElectronAPI();
    (api.repository.create as jest.Mock).mockResolvedValue({ success: true, data: createdRepo });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should delete the created repository record when the clone fails', async () => {
    // Given: the record is created but the clone errors
    (api.lore.repository.clone as jest.Mock).mockResolvedValue({
      success: false,
      error: 'network unreachable',
    });

    // When: a new repository is submitted
    const { result } = renderHook(() => useRepositorySubmission(deps));
    await act(async () => {
      await result.current.submit(cloneInput);
    });

    // Then: the orphaned record is rolled back and the error is surfaced
    expect(api.repository.delete).toHaveBeenCalledWith(createdRepo.id);
    expect(result.current.error).toBe('network unreachable');
    expect(result.current.isCloning).toBe(false);
    expect(deps.onAdd).not.toHaveBeenCalled();
  });

  it('should keep the repository record when the clone succeeds', async () => {
    // Given: a clone that succeeds (mock default)
    const { result } = renderHook(() => useRepositorySubmission(deps));

    // When: a new repository is submitted and the completion pause elapses
    await act(async () => {
      await result.current.submit(cloneInput);
    });
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    // Then: nothing is deleted and the repository is handed to the caller
    expect(api.repository.delete).not.toHaveBeenCalled();
    expect(deps.onAdd).toHaveBeenCalledWith(createdRepo);
    expect(deps.onClose).toHaveBeenCalled();
  });

  it('should report real clone progress from the push channel, scoped to this clone', async () => {
    // Given: a clone held in flight while progress events stream
    let progressCallback: ((payload: unknown) => void) | undefined;
    const unsubscribe = jest.fn();
    (api.lore.repository.onCloneProgress as jest.Mock).mockImplementation(
      (callback: (payload: unknown) => void) => {
        progressCallback = callback;
        return unsubscribe;
      }
    );
    let resolveClone!: (value: unknown) => void;
    (api.lore.repository.clone as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        resolveClone = resolve;
      })
    );

    const { result } = renderHook(() => useRepositorySubmission(deps));
    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = result.current.submit(cloneInput);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // When: the main process pushes progress for this clone's destination
    act(() => {
      progressCallback!({ localPath: '/repos/RepoA', percent: 42 });
    });

    // Then: the reported percent is the real one
    expect(result.current.cloneProgress).toBe(42);

    // When: progress for a different clone destination arrives
    act(() => {
      progressCallback!({ localPath: '/somewhere/else', percent: 99 });
    });

    // Then: it is ignored
    expect(result.current.cloneProgress).toBe(42);

    // When: the clone completes
    await act(async () => {
      resolveClone({ success: true, data: undefined });
      await submitPromise;
    });

    // Then: the subscription is released
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('should not fire completion callbacks after unmount', async () => {
    // Given: a successful submission whose completion pause is still pending
    const { result, unmount } = renderHook(() => useRepositorySubmission(deps));
    await act(async () => {
      await result.current.submit(cloneInput);
    });

    // When: the modal unmounts before the 500ms completion pause elapses
    unmount();
    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Then: no callback fires against the unmounted tree
    expect(deps.onAdd).not.toHaveBeenCalled();
    expect(deps.onClose).not.toHaveBeenCalled();
    expect(deps.onDone).not.toHaveBeenCalled();
  });
});
