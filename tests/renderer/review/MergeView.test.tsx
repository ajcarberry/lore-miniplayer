jest.mock('@mantine/notifications', () => ({ notifications: { show: jest.fn() } }));

import { notifications } from '@mantine/notifications';
import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeView } from '../../../src/renderer/components/review/MergeView';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeCard, makeWorkspace } from '../mission-control/fixtures';
import type {
  AgentIntention,
  FileDiffResult,
  MergeState,
  ReviewOpenRequest,
  WorkspaceModelSnapshot,
} from '../../../src/shared/types';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_PATH = '/wt/act2-balance';
const SOURCE_BRANCH = 'agent/act2-balance';
const TARGET_BRANCH = 'main';

function makeRequest(overrides: Partial<ReviewOpenRequest> = {}): ReviewOpenRequest {
  return {
    workspacePath: WORKSPACE_PATH,
    repositoryId: REPO_ID,
    branchName: SOURCE_BRANCH,
    revision: 'r128',
    workflow: 'merge',
    compare: {
      source: { kind: 'branchHead', branch: SOURCE_BRANCH },
      target: { kind: 'branchHead', branch: TARGET_BRANCH },
    },
    title: 'Balance pass',
    ...overrides,
  };
}

// A merge where both changed files auto-merged with no conflicts.
function cleanState(): MergeState {
  return {
    sourceBranch: SOURCE_BRANCH,
    targetBranch: TARGET_BRANCH,
    allResolved: true,
    hasChangesToLand: true,
    files: [
      { path: 'encounters.toml', state: 'merged' },
      { path: 'loot.toml', state: 'merged' },
    ],
  };
}

// A merge with one auto-merged file and one conflict still unresolved.
function conflictedState(): MergeState {
  return {
    sourceBranch: SOURCE_BRANCH,
    targetBranch: TARGET_BRANCH,
    allResolved: false,
    hasChangesToLand: true,
    files: [
      { path: 'encounters.toml', state: 'merged' },
      { path: 'boss.toml', state: 'conflict' },
    ],
  };
}

// A merge where phase-1 is clean (no rows) but the branch is ahead — commits
// still to land (the "nothing to merge" bug scenario).
function aheadCleanState(): MergeState {
  return {
    sourceBranch: SOURCE_BRANCH,
    targetBranch: TARGET_BRANCH,
    allResolved: true,
    hasChangesToLand: true,
    files: [],
  };
}

// A merge with nothing to land — the branch tip is already on the target.
function nothingToLandState(): MergeState {
  return {
    sourceBranch: SOURCE_BRANCH,
    targetBranch: TARGET_BRANCH,
    allResolved: true,
    hasChangesToLand: false,
    files: [],
  };
}

const CONFLICT_DIFF: FileDiffResult[] = [
  {
    path: 'boss.toml',
    action: 'modified',
    // source=theirs(main), target=mine(branch): removed = theirs, added = mine.
    patch: '@@ -1,2 +1,2 @@\n [boss]\n-hp = 900\n+hp = 1200\n',
    binary: false,
    truncated: false,
    lineStats: { added: 1, removed: 1 },
  },
];

interface Api {
  start: jest.Mock;
  resolve: jest.Mock;
  abort: jest.Mock;
  complete: jest.Mock;
  compare: jest.Mock;
  close: jest.Mock;
}

function installApi(
  options: {
    startState?: MergeState;
    startError?: string;
  } = {}
): Api {
  const api = installMockElectronAPI();

  const start = jest
    .fn()
    .mockResolvedValue(
      options.startError !== undefined
        ? { success: false, error: options.startError }
        : { success: true, data: options.startState ?? conflictedState() }
    );
  // Resolving a file returns an all-resolved single-conflict state carrying the
  // chosen resolution (the common one-conflict-per-file case).
  const resolve = jest
    .fn()
    .mockImplementation(async (request: { path: string; resolution: 'mine' | 'theirs' }) => ({
      success: true,
      data: {
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        allResolved: true,
        hasChangesToLand: true,
        files: [
          { path: 'encounters.toml', state: 'merged' },
          { path: request.path, state: 'conflict', resolution: request.resolution },
        ],
      } satisfies MergeState,
    }));
  const abort = jest.fn().mockResolvedValue({ success: true, data: { aborted: true } });
  const complete = jest.fn().mockResolvedValue({ success: true, data: { revision: 'r131' } });
  const compare = jest.fn().mockResolvedValue({ success: true, data: CONFLICT_DIFF });

  api.repository.list = jest.fn().mockResolvedValue({
    success: true,
    data: [
      {
        id: REPO_ID,
        name: 'emberfall',
        url: 'lore://h/e',
        localPath: '/e',
        accentHue: 74,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  });
  api.lore.branchGraph = jest.fn().mockResolvedValue({
    success: true,
    data: {
      current: 'r130',
      branch: {
        name: SOURCE_BRANCH,
        revisions: [
          { revision: 'r130', revisionNumber: 130, message: 'Flatten pacing' },
          { revision: 'r129', revisionNumber: 129, message: 'Retune ambush' },
        ],
      },
      mergesFromParent: [],
      mergesToParent: [],
    },
  });

  Object.assign(api, {
    merge: { start, resolve, abort, complete },
    diff: { compare },
  });

  return { start, resolve, abort, complete, compare, close: api.window.close as jest.Mock };
}

function renderView(request: ReviewOpenRequest = makeRequest()): void {
  render((<MantineProvider>{<MergeView request={request} />}</MantineProvider>) as ReactElement);
}

describe('MergeView — clean merge', () => {
  it('starts the merge against the target branch and enables Merge immediately', async () => {
    const api = installApi({ startState: cleanState() });
    renderView();

    // Header states the branches and the commit/conflict tally.
    expect(
      await screen.findByText(`Merge — ${SOURCE_BRANCH} → ${TARGET_BRANCH}`)
    ).toBeInTheDocument();
    expect(screen.getByText(/2 commits · 0 conflicts/)).toBeInTheDocument();

    // Auto-merged files are shown inert with the guidance note.
    expect(screen.getByText(/Auto-merged files need no action/i)).toBeInTheDocument();
    expect(screen.getByText('encounters.toml')).toBeInTheDocument();

    // No conflicts → Merge is enabled from the start.
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();

    expect(api.start).toHaveBeenCalledWith({
      repositoryPath: WORKSPACE_PATH,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
    });
  });
});

describe('MergeView — branch ahead but phase-1 clean', () => {
  it('shows a ready-to-land message (not "nothing to merge") and enables Merge', async () => {
    // Given: the target has not moved, so there are no conflicts and no
    // auto-merges, but the branch is still ahead (has commits to land).
    installApi({ startState: aheadCleanState() });
    renderView();

    // Then: it does NOT claim the branches are in sync; it says it is ready to
    // land, and Merge is enabled.
    expect(
      await screen.findByText(new RegExp(`ahead of ${TARGET_BRANCH} and is ready to land`, 'i'))
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing to merge — the branches are already in sync/i)
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled();
  });
});

describe('MergeView — nothing to land', () => {
  it('says nothing to merge and disables Merge when the branch tip is already on the target', async () => {
    // Given: a clean phase-1 update AND the branch is not ahead.
    installApi({ startState: nothingToLandState() });
    renderView();

    // Then: it reports the branches are in sync and Merge is disabled.
    expect(
      await screen.findByText(/Nothing to merge — the branches are already in sync/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
  });
});

// Points the mission-control snapshot bridge (which useIntention reuses) at a
// card for this workspace, optionally carrying an agent intention.
function installIntentionSnapshot(intention?: AgentIntention): void {
  const workspace = makeWorkspace({ path: WORKSPACE_PATH });
  const card = makeCard('awaitingReview', {
    workspace,
    ...(intention ? { intention } : {}),
  });
  const snapshot: WorkspaceModelSnapshot = { repositoryId: REPO_ID, cards: [card] };
  Object.assign(window.electronAPI, {
    missionControl: {
      open: jest.fn(),
      close: jest.fn(),
      watch: jest.fn().mockResolvedValue({ success: true, data: snapshot }),
      onSnapshot: jest.fn().mockReturnValue(jest.fn()),
    },
  });
}

describe('MergeView — sidebar intention', () => {
  it('keeps the merging commits and conflicts ledger above the intention panel', async () => {
    installApi();
    renderView();

    // The design-2c sidebar sections render alongside the intention panel.
    expect(await screen.findByText('Merging commits')).toBeInTheDocument();
    expect(screen.getByText('Conflicts')).toBeInTheDocument();
    expect(screen.getByText('Flatten pacing')).toBeInTheDocument();
  });

  it('degrades to the intention placeholder when no agent session is recorded', async () => {
    installApi();
    renderView();

    // The landed IntentionPanel renders its own graceful-degradation placeholder.
    expect(await screen.findByText('No agent session recorded.')).toBeInTheDocument();
  });

  it('renders the agent intention (Asked) from the workspace snapshot', async () => {
    installApi();
    installIntentionSnapshot({
      prompt: 'Rebalance the ravine ambush encounter.',
      title: 'Rebalance ravine ambush',
      tasks: [{ subject: 'Retune elite spawn timing', status: 'running', runningElapsedMs: 4200 }],
      commentary: [],
      summary: 'Staggered the spawns over six seconds.',
      sessionId: '9f2c',
      costUsd: 1.62,
    });
    renderView();

    expect(await screen.findByText('Rebalance the ravine ambush encounter.')).toBeInTheDocument();
    expect(screen.getByText('Retune elite spawn timing')).toBeInTheDocument();
    // The sidebar's own sections remain present.
    expect(screen.getByText('Merging commits')).toBeInTheDocument();
  });
});

describe('MergeView — conflicted merge', () => {
  it('gates Merge until the conflict is resolved and fetches both sides', async () => {
    const api = installApi();
    renderView();

    // Merge is gated while a conflict is unresolved.
    expect(await screen.findByText(/0 of 1 conflicts resolved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();

    // Both sides of the conflicted file are fetched via the diff bridge:
    // theirs = target head (main), mine = source head (branch).
    await waitFor(() =>
      expect(api.compare).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryPath: WORKSPACE_PATH,
          source: { kind: 'branchHead', branch: TARGET_BRANCH },
          target: { kind: 'branchHead', branch: SOURCE_BRANCH },
          paths: ['boss.toml'],
        })
      )
    );

    // The side-by-side content renders both the theirs and mine lines.
    expect(await screen.findByText(/hp = 900/)).toBeInTheDocument();
    expect(screen.getByText(/hp = 1200/)).toBeInTheDocument();
  });

  it('resolves accept-mine, persists the accepted state, and enables Merge', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('button', { name: 'Accept mine' });

    await user.click(screen.getByRole('button', { name: 'Accept mine' }));

    expect(api.resolve).toHaveBeenCalledWith({
      repositoryPath: WORKSPACE_PATH,
      path: 'boss.toml',
      resolution: 'mine',
    });

    // Accepted state persists in the block and the ledger; Merge unlocks.
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('kept mine')).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 conflicts resolved/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Merge' })).toBeEnabled());
  });

  it('resolves accept-theirs through the merge bridge', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('button', { name: 'Accept theirs' });

    await user.click(screen.getByRole('button', { name: 'Accept theirs' }));

    expect(api.resolve).toHaveBeenCalledWith({
      repositoryPath: WORKSPACE_PATH,
      path: 'boss.toml',
      resolution: 'theirs',
    });
    expect(await screen.findByText('kept theirs')).toBeInTheDocument();
  });

  it('surfaces a resolve failure without crashing', async () => {
    const api = installApi();
    api.resolve.mockResolvedValue({ success: false, error: 'resolve boom' });
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('button', { name: 'Accept mine' });

    await user.click(screen.getByRole('button', { name: 'Accept mine' }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Resolve failed' })
      )
    );
    // Still gated (resolution did not take).
    expect(screen.getByRole('button', { name: 'Merge' })).toBeDisabled();
  });
});

describe('MergeView — abort', () => {
  it('confirms before discarding and closes the window on abort', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('button', { name: 'Abort' });

    await user.click(screen.getByRole('button', { name: 'Abort' }));
    // A confirm dialog appears; the merge is not aborted yet.
    expect(await screen.findByText('Discard this merge?')).toBeInTheDocument();
    expect(api.abort).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Discard merge' }));
    expect(api.abort).toHaveBeenCalledWith({ repositoryPath: WORKSPACE_PATH });
    await waitFor(() => expect(api.close).toHaveBeenCalled());
  });

  it('surfaces an abort failure as an alert', async () => {
    const api = installApi();
    api.abort.mockResolvedValue({ success: false, error: 'abort boom' });
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('button', { name: 'Abort' });

    await user.click(screen.getByRole('button', { name: 'Abort' }));
    await user.click(await screen.findByRole('button', { name: 'Discard merge' }));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Abort failed' })
      )
    );
    expect(api.close).not.toHaveBeenCalled();
  });
});

describe('MergeView — complete', () => {
  it('lands the merge and surfaces the landed revision', async () => {
    const api = installApi({ startState: cleanState() });
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('button', { name: 'Merge' });

    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(api.complete).toHaveBeenCalledWith({ repositoryPath: WORKSPACE_PATH });
    // The landed revision is surfaced in the success alert and the bottom bar.
    expect((await screen.findAllByText(/landed r131 on main/i)).length).toBeGreaterThan(0);
    // Abort is gone once the merge has landed.
    expect(screen.queryByRole('button', { name: 'Abort' })).not.toBeInTheDocument();
  });

  it('surfaces a completion failure as an alert and keeps the merge open', async () => {
    const api = installApi({ startState: cleanState() });
    api.complete.mockResolvedValue({ success: false, error: 'land boom' });
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('button', { name: 'Merge' });

    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(await screen.findByText('Merge could not be completed')).toBeInTheDocument();
    expect(screen.getByText(/land boom/)).toBeInTheDocument();
  });
});

describe('MergeView — start failure', () => {
  it('surfaces a start failure as an alert instead of the merge body', async () => {
    installApi({ startError: 'start boom' });
    renderView();

    expect(await screen.findByText('Could not start the merge')).toBeInTheDocument();
    expect(screen.getByText(/start boom/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
  });
});

describe('MergeView — multi-region conflict', () => {
  it('labels a file with more than one conflict region "applies to whole file"', async () => {
    const api = installApi();
    api.compare.mockResolvedValue({
      success: true,
      data: [
        {
          path: 'boss.toml',
          action: 'modified',
          patch: '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -5,1 +5,1 @@\n-c\n+d\n',
          binary: false,
          truncated: false,
          lineStats: { added: 2, removed: 2 },
        },
      ],
    });
    renderView();

    const block = await screen.findByTestId('conflict-block-boss.toml');
    expect(within(block).getByText(/applies to whole file/i)).toBeInTheDocument();
  });
});
