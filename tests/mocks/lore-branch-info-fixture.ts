// No live Lore repository was reachable in this environment, so this
// fixture is constructed field-for-field from `LoreBranchInfoEventData` in
// `@lore-vcs/sdk/dist/types/events/index.d.ts` rather than captured from a
// real BRANCH_INFO event. It is type-derived, not captured.
export const branchInfoEventDataFixture = {
  id: 'branch-0f3a9c2e',
  name: 'main',
  category: 'user',
  latest: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  latestRemote: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  parent: '',
  branchPoint: '',
  creator: 'user-1',
  created: 1700000000,
  stack: [],
  archived: false,
};
