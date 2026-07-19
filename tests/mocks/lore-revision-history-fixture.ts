// Constructed field-for-field from `LoreRevisionHistoryEntryEventData`
// rather than captured from a live server. It is type-derived, not
// captured.
//
// The `REVISION_HISTORY_ENTRY` event carries no commit-message/author/
// timestamp fields itself; the enrichment path is a follow-up
// `revisionInfo(g, { revision: <full hash> })` call per entry, which
// streams METADATA events carrying `message`/`timestamp` (see
// lore-revision-info-fixture.ts).
export const revisionHistoryEntryEventDataFixture = {
  revision: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  revisionNumber: 42,
  parent: ['f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5', ''] as [string, string],
};
