// Captured (field shape) from a live Lore server:
// `lore.revisionInfo(g, { revision: <full 64-char hash> })` emits a
// REVISION_INFO event plus one METADATA event per known key.
// Locally-created revisions carry `message` and `timestamp` but no
// `author` key.
import { LoreMetadataTag } from '@lore-vcs/sdk/types/enums';

export const revisionInfoEventDataFixture = {
  repository: '019f6e085ebc76e0b055ac33144de5cf',
  revision: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  revisionNumber: 8,
  parent: [
    'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
    '0000000000000000000000000000000000000000000000000000000000000000',
  ] as [string, string],
};

export const revisionMessageMetadataFixture = {
  key: 'message',
  value: { tag: LoreMetadataTag.STRING, tagName: 'string', data: 'Crystal subsurface pass' },
};

export const revisionTimestampMetadataFixture = {
  key: 'timestamp',
  value: { tag: LoreMetadataTag.NUMERIC, tagName: 'numeric', data: 1784352827564 },
};

export const revisionBranchMetadataFixture = {
  key: 'branch',
  value: {
    tag: LoreMetadataTag.CONTEXT,
    tagName: 'context',
    data: 'e726318bbc3fd75ac8733a7e030cc35b',
  },
};
