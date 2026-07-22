import { notifications } from '@mantine/notifications';
import type { ReviewWorkflowMode, Workspace } from '../../../shared/types';

// A typed "open the review window" request. Mission Control's Review / Commit /
// Merge buttons emit one of these; the review window (P11/P14) will consume it
// with its targets + workflow preloaded (design 2a: "buttons preload its
// targets and workflow").
export interface OpenReviewIntent {
  readonly workspace: Workspace;
  readonly workflow: ReviewWorkflowMode;
}

// TODO(P11): wire to the review-window open channel once P11 defines it. P2
// defines no review-window channel yet, so this is the renderer-side seam:
// it surfaces an honest "not yet" notice instead of opening anything. No review
// UI is built here (packet: "Do NOT build any review UI here").
export function requestOpenReviewWindow(intent: OpenReviewIntent): void {
  const verb = intent.workflow === 'merge' ? 'Merge' : 'Review';
  notifications.show({
    color: 'yellow',
    title: 'Review window coming soon',
    message: `${verb} for ${intent.workspace.branchName} isn't available yet.`,
  });
}
