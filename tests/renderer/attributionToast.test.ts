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
