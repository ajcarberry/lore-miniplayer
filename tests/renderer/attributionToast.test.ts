import { formatAttributionMessage } from '../../src/renderer/utils/attributionToast';
import type { RepositoryNotification } from '../../src/shared/types';

function notification(overrides: Partial<RepositoryNotification> = {}): RepositoryNotification {
  return {
    repositoryPath: '/tmp/my-repo',
    kind: 'branchPushed',
    ...overrides,
  };
}

describe('formatAttributionMessage', () => {
  it('formats a push with a known revision number', () => {
    // When: a branchPushed notification arrives with a resolved tip
    const message = formatAttributionMessage(
      notification({ kind: 'branchPushed', userId: 'mara-voss' }),
      'feature/act-two',
      128
    );

    // Then: the sentence names who, the revision, and the branch
    expect(message).toBe('mara-voss pushed r128 to feature/act-two');
  });

  it('drops the revision clause when the tip is not yet known, rather than fabricate one', () => {
    // When: the branch graph hasn't resolved a tip yet
    const message = formatAttributionMessage(
      notification({ kind: 'branchPushed', userId: 'mara-voss' }),
      'feature/act-two',
      undefined
    );

    // Then: no invented revision number appears
    expect(message).toBe('mara-voss pushed to feature/act-two');
  });

  it('falls back to "Someone" when the notification carries no userId', () => {
    // When: a push notification with no userId (P5 fallback gap)
    const message = formatAttributionMessage(
      notification({ kind: 'branchPushed', userId: undefined }),
      'main',
      1
    );

    // Then: the sentence still reads, without a blank subject
    expect(message).toBe('Someone pushed r1 to main');
  });

  it('formats a lock notification naming the locked path', () => {
    // When: a resourceLocked notification arrives with one path
    const message = formatAttributionMessage(
      notification({ kind: 'resourceLocked', userId: 'rowan', paths: ['levels/act2/pacing.toml'] }),
      'main',
      undefined
    );

    // Then: it names who locked which file
    expect(message).toBe('rowan locked levels/act2/pacing.toml');
  });

  it('formats an unlock notification with the "unlocked" verb', () => {
    // When: a resourceUnlocked notification arrives
    const message = formatAttributionMessage(
      notification({ kind: 'resourceUnlocked', userId: 'rowan', paths: ['file.txt'] }),
      'main',
      undefined
    );

    // Then: the verb flips to unlocked
    expect(message).toBe('rowan unlocked file.txt');
  });

  it('summarizes multiple locked paths with a "+N more" suffix', () => {
    // When: a lock notification carries several paths
    const message = formatAttributionMessage(
      notification({
        kind: 'resourceLocked',
        userId: 'rowan',
        paths: ['a.txt', 'b.txt', 'c.txt'],
      }),
      'main',
      undefined
    );

    // Then: only the first path is named, with a count of the rest
    expect(message).toBe('rowan locked a.txt (+2 more)');
  });

  it('falls back to a generic file mention when a lock notification carries no paths', () => {
    // When: a lock notification with an empty paths array
    const message = formatAttributionMessage(
      notification({ kind: 'resourceLocked', userId: 'rowan', paths: [] }),
      'main',
      undefined
    );

    // Then: a generic sentence still renders
    expect(message).toBe('rowan locked a file');
  });

  it('returns null for branchCreated — nothing attributable to toast', () => {
    // When: a branchCreated notification arrives (no userId ever)
    const message = formatAttributionMessage(notification({ kind: 'branchCreated' }), 'main', 1);

    // Then: no toast message
    expect(message).toBeNull();
  });

  it('returns null for branchDeleted — nothing attributable to toast', () => {
    // When: a branchDeleted notification arrives
    const message = formatAttributionMessage(notification({ kind: 'branchDeleted' }), 'main', 1);

    // Then: no toast message
    expect(message).toBeNull();
  });
});
