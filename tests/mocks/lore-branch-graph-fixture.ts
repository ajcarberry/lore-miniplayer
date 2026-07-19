// Branch-graph SDK event fixtures. The hash/id shapes and the branch-graph
// relationships (a `feature/x` child branched from `main` at a branch point,
// with one merge accepted back from the parent) mirror a live demo
// repository: `branchList` entries carry each branch's tip; `branchInfo`
// carries the parent branch id + branch point; a merge revision's `parent`
// tuple carries the parent-lineage hash as its second element.
import { LoreBranchLocation } from '@lore-vcs/sdk/types/enums';

const MAIN_ID = 'e726318bbc3fd75ac8733a7e030cc35b';
const FEATURE_ID = '019f6e08d1b871d388917c3f948b8e70';

// Parent (main) lineage tip → root, newest-first.
export const MAIN_TIP = 'm4m4m4m4m4m4m4m4m4m4m4m4m4m4m4m4m4m4m4m4';
export const MAIN_R3 = 'm3m3m3m3m3m3m3m3m3m3m3m3m3m3m3m3m3m3m3m3';
const MAIN_R2 = 'm2m2m2m2m2m2m2m2m2m2m2m2m2m2m2m2m2m2m2m2';
// Branch point: where feature/x was created off main.
export const BRANCH_POINT = 'm1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1m1';

// Child (feature/x) lineage tip → branch point, newest-first.
export const FEATURE_TIP = 'f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3';
// The merge revision: its other-parent (MAIN_R3) sits on the parent lineage.
export const FEATURE_MERGE = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';

const ZERO = '0000000000000000000000000000000000000000';

export const branchListEntriesFixture = [
  {
    id: MAIN_ID,
    name: 'main',
    latest: MAIN_TIP,
    isCurrent: true,
    location: LoreBranchLocation.LOCAL,
  },
  {
    id: FEATURE_ID,
    name: 'feature/x',
    latest: FEATURE_TIP,
    isCurrent: false,
    location: LoreBranchLocation.REMOTE,
  },
];

export const featureBranchInfoFixture = {
  id: FEATURE_ID,
  name: 'feature/x',
  category: 'user',
  latest: FEATURE_TIP,
  latestRemote: FEATURE_TIP,
  parent: MAIN_ID,
  branchPoint: BRANCH_POINT,
  creator: 'user-1',
  created: 1700000000,
  stack: [{ branch: MAIN_ID, revision: BRANCH_POINT }],
  archived: false,
};

// main has no parent branch — parent id and branch point are all zeros.
export const mainBranchInfoFixture = {
  ...featureBranchInfoFixture,
  id: MAIN_ID,
  name: 'main',
  parent: '00000000000000000000000000000000',
  branchPoint: ZERO,
  stack: [],
};

// Child walk from FEATURE_TIP (newest-first): tip, a merge from parent, then
// the branch point.
export const featureHistoryFixture = [
  { revision: FEATURE_TIP, revisionNumber: 3, parent: [FEATURE_MERGE, ZERO] as [string, string] },
  {
    revision: FEATURE_MERGE,
    revisionNumber: 2,
    parent: [BRANCH_POINT, MAIN_R3] as [string, string],
  },
  { revision: BRANCH_POINT, revisionNumber: 1, parent: [MAIN_R2, ZERO] as [string, string] },
];

// Parent walk from MAIN_TIP (newest-first).
export const mainHistoryFixture = [
  { revision: MAIN_TIP, revisionNumber: 4, parent: [MAIN_R3, ZERO] as [string, string] },
  { revision: MAIN_R3, revisionNumber: 3, parent: [MAIN_R2, ZERO] as [string, string] },
  { revision: MAIN_R2, revisionNumber: 2, parent: [BRANCH_POINT, ZERO] as [string, string] },
  { revision: BRANCH_POINT, revisionNumber: 1, parent: [ZERO, ZERO] as [string, string] },
];

// Extended flow: after the merge down (FEATURE_MERGE), the child continues
// (FEATURE_TIP), merges up into main (MAIN_MERGE_UP, whose other-parent is
// the child-lineage hash FEATURE_TIP), and then BOTH branches continue
// (FEATURE_CONTINUE on the child, MAIN_CONTINUE on the parent).
export const FEATURE_CONTINUE = 'f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4';
export const MAIN_MERGE_UP = 'm5m5m5m5m5m5m5m5m5m5m5m5m5m5m5m5m5m5m5m5';
export const MAIN_CONTINUE = 'm6m6m6m6m6m6m6m6m6m6m6m6m6m6m6m6m6m6m6m6';

// Child walk from FEATURE_CONTINUE (newest-first): the continuation revision,
// then the original lineage.
export const extendedFeatureHistoryFixture = [
  {
    revision: FEATURE_CONTINUE,
    revisionNumber: 4,
    parent: [FEATURE_TIP, ZERO] as [string, string],
  },
  ...featureHistoryFixture,
];

// Parent walk from MAIN_CONTINUE (newest-first): the continuation revision,
// the merge accepted up from the child, then the original main lineage.
export const extendedMainHistoryFixture = [
  { revision: MAIN_CONTINUE, revisionNumber: 6, parent: [MAIN_MERGE_UP, ZERO] as [string, string] },
  {
    revision: MAIN_MERGE_UP,
    revisionNumber: 5,
    parent: [MAIN_TIP, FEATURE_TIP] as [string, string],
  },
  ...mainHistoryFixture,
];
