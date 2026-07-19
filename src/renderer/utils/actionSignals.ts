import type { BranchDivergenceState } from '../../shared/types';

// The three glanceable signals the player surfaces: is the workspace on
// outdated state (sync), is there local uncommitted work (commit), and are
// local commits unpushed (push). Shared by the transport row's accents and
// the collapsed pill's indicator glyphs.
export interface ActionSignals {
  readonly syncNeeded: boolean;
  readonly uncommitted: boolean;
  readonly unpushed: boolean;
}

// The workspace can sit on an older revision of the branch (sync-to-
// revision) even while the branch tips are in sync with the remote — Sync
// is still the actionable next step. Empty hashes mean the graph is loading
// or degraded, in which case no claim is made.
export function isWorkspaceBehindTip(currentRevision: string, branchTipRevision: string): boolean {
  return (
    currentRevision !== '' && branchTipRevision !== '' && currentRevision !== branchTipRevision
  );
}

export function computeActionSignals(inputs: {
  readonly divergenceState: BranchDivergenceState | undefined;
  readonly currentRevision: string;
  readonly branchTipRevision: string;
  readonly dirtyCount: number;
}): ActionSignals {
  const { divergenceState, currentRevision, branchTipRevision, dirtyCount } = inputs;
  return {
    syncNeeded:
      divergenceState === 'behindOrDiverged' ||
      isWorkspaceBehindTip(currentRevision, branchTipRevision),
    uncommitted: dirtyCount > 0,
    unpushed: divergenceState === 'ahead',
  };
}
