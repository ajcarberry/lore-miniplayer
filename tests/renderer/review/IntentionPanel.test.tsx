import { screen, waitFor } from '@testing-library/react';
import { IntentionPanel } from '../../../src/renderer/components/review/IntentionPanel';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeCard, makeWorkspace, renderWithMantine, REPO_ID } from '../mission-control/fixtures';
import type { AgentIntention, WorkspaceModelSnapshot } from '../../../src/shared/types';

const WORKSPACE_PATH = '/Users/rowan/work/emberfall-wt/act2-balance';

const FULL_INTENTION: AgentIntention = {
  prompt: 'Rebalance the ravine ambush encounter for a smoother difficulty curve.',
  tasks: [
    { subject: 'Read the current encounter config', status: 'done' },
    { subject: 'Retune elite spawn timing', status: 'running', runningElapsedMs: 4200 },
    { subject: 'Playtest the new curve', status: 'pending' },
  ],
  commentary: [{ at: 1000, text: 'Starting with the spawn delay.' }],
  summary: 'Reduced elite density and staggered spawns so the ambush ramps in over six seconds.',
  sessionId: '9f2c',
};

function installSnapshot(intention: AgentIntention | undefined): void {
  const api = installMockElectronAPI();
  const workspace = makeWorkspace({ path: WORKSPACE_PATH });
  const card = makeCard('awaitingReview', {
    workspace,
    ...(intention ? { intention } : {}),
  });
  const snapshot: WorkspaceModelSnapshot = { repositoryId: REPO_ID, cards: [card] };
  const watch = jest.fn().mockResolvedValue({ success: true, data: snapshot });
  const onSnapshot = jest.fn().mockReturnValue(jest.fn());
  Object.assign(api, { missionControl: { open: jest.fn(), close: jest.fn(), watch, onSnapshot } });
}

function renderPanel(): void {
  renderWithMantine(<IntentionPanel repositoryId={REPO_ID} workspacePath={WORKSPACE_PATH} />);
}

describe('IntentionPanel', () => {
  it('renders every section of a full intention', async () => {
    // Given: a workspace card carrying a full AgentIntention
    installSnapshot(FULL_INTENTION);

    // When: the panel mounts
    renderPanel();

    // Then: Asked, task list (N of M), agent's account, and the session
    // footer all render
    expect(
      await screen.findByText(
        'Rebalance the ravine ambush encounter for a smoother difficulty curve.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Tasks (1 of 3)')).toBeInTheDocument();
    expect(screen.getByText('Read the current encounter config')).toBeInTheDocument();
    expect(screen.getByText('Retune elite spawn timing')).toBeInTheDocument();
    expect(screen.getByText('Playtest the new curve')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Reduced elite density and staggered spawns so the ambush ramps in over six seconds.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('from transcript · session 9f2c')).toBeInTheDocument();
  });

  it('renders the done/running/pending task glyphs', async () => {
    // Given: a full intention with one task in each status
    installSnapshot(FULL_INTENTION);

    // When: the panel mounts
    renderPanel();
    await screen.findByTestId('intention-tasks');

    // Then: each glyph appears once
    expect(screen.getByText('✓')).toBeInTheDocument();
    expect(screen.getByText('▶')).toBeInTheDocument();
    expect(screen.getByText('○')).toBeInTheDocument();
  });

  it('renders only the sections a partial intention (no tasks) carries', async () => {
    // Given: an intention with a prompt and summary but no tasks
    installSnapshot({
      prompt: 'Fix the pacing dip in act two.',
      tasks: [],
      commentary: [],
      summary: 'Smoothed the pacing curve across three encounters.',
      sessionId: '1a2b',
    });

    // When: the panel mounts
    renderPanel();

    // Then: Asked and the account render; the task section does not
    expect(await screen.findByTestId('intention-asked')).toBeInTheDocument();
    expect(screen.getByTestId('intention-summary')).toBeInTheDocument();
    expect(screen.queryByTestId('intention-tasks')).not.toBeInTheDocument();
  });

  it('renders only the sections a partial intention (no summary) carries', async () => {
    // Given: an intention with a prompt and tasks but no summary
    installSnapshot({
      prompt: 'Fix the pacing dip in act two.',
      tasks: [{ subject: 'Read encounter logs', status: 'done' }],
      commentary: [],
      sessionId: '1a2b',
    });

    // When: the panel mounts
    renderPanel();

    // Then: Asked and tasks render; the account section does not
    expect(await screen.findByTestId('intention-asked')).toBeInTheDocument();
    expect(screen.getByTestId('intention-tasks')).toBeInTheDocument();
    expect(screen.queryByTestId('intention-summary')).not.toBeInTheDocument();
  });

  it('renders the diff-only placeholder when the workspace has no intention', async () => {
    // Given: a card with no intention at all (no transcript enrichment)
    installSnapshot(undefined);

    // When: the panel mounts
    renderPanel();

    // Then: the degrade placeholder shows, and no session footer renders
    expect(await screen.findByText('No agent session recorded.')).toBeInTheDocument();
    expect(screen.queryByText(/from transcript/)).not.toBeInTheDocument();
  });

  it('renders the placeholder when the intention is present but entirely empty', async () => {
    // Given: an intention record with no prompt, tasks, or summary (a
    // transcript that parsed but yielded nothing usable)
    installSnapshot({ tasks: [], commentary: [] });

    // When: the panel mounts
    renderPanel();

    // Then: it degrades the same as an absent intention
    await waitFor(() => expect(screen.getByText('No agent session recorded.')).toBeInTheDocument());
  });
});
