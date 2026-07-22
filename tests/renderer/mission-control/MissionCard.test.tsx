import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MissionCard } from '../../../src/renderer/components/mission-control/MissionCard';
import type { MissionCardProps } from '../../../src/renderer/components/mission-control/MissionCard';
import { makeCard, makeWorkspace, renderWithMantine } from './fixtures';

function baseProps(overrides: Partial<MissionCardProps> = {}): MissionCardProps {
  return {
    card: makeCard('awaitingReview', {
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
      intention: {
        prompt: 'Rebalance Act II encounters.',
        summary: 'Retuned the ravine ambush.',
        tasks: [],
        commentary: [],
      },
    }),
    onOpenTerminal: jest.fn(),
    onTeardown: jest.fn(),
    onReview: jest.fn(),
    onForget: jest.fn(),
    ...overrides,
  };
}

describe('MissionCard — awaiting review (clean)', () => {
  it('renders the prompt, agent summary, workspace stats, and session commits', () => {
    renderWithMantine(<MissionCard {...baseProps()} />);

    expect(screen.getByText('“Rebalance Act II encounters.”')).toBeInTheDocument();
    expect(screen.getByText('Agent:')).toBeInTheDocument();
    expect(screen.getByText('Retuned the ravine ambush.')).toBeInTheDocument();
    expect(screen.getByText('Workspace · 3 files · +38 −21')).toBeInTheDocument();
    expect(screen.getByText('Session commits · 2')).toBeInTheDocument();
    expect(screen.getByText(/r130 Flatten pacing curve/)).toBeInTheDocument();
  });

  it('exposes the worktree path as the name hover title', () => {
    renderWithMantine(<MissionCard {...baseProps()} />);
    expect(screen.getByText('agent/act2-balance')).toHaveAttribute(
      'title',
      '/Users/rowan/work/emberfall-wt/act2-balance'
    );
  });

  it('offers Merge → main for a clean workspace and dispatches a merge review', async () => {
    const user = userEvent.setup();
    const onReview = jest.fn();
    renderWithMantine(<MissionCard {...baseProps({ onReview })} />);

    expect(screen.queryByRole('button', { name: 'Commit' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge → main' }));

    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ workflow: 'merge' }));
  });

  it('dispatches Open terminal with the worktree path and teardown with the card', async () => {
    const user = userEvent.setup();
    const onOpenTerminal = jest.fn();
    const onTeardown = jest.fn();
    const props = baseProps({ onOpenTerminal, onTeardown });
    renderWithMantine(<MissionCard {...props} />);

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(onOpenTerminal).toHaveBeenCalledWith('/Users/rowan/work/emberfall-wt/act2-balance');

    await user.click(screen.getByRole('button', { name: /Close workspace/ }));
    expect(onTeardown).toHaveBeenCalledWith(props.card);
  });
});

describe('MissionCard — awaiting review (dirty)', () => {
  it('shows an uncommitted chiplet and a Commit action instead of Merge', async () => {
    const user = userEvent.setup();
    const onReview = jest.fn();
    const card = makeCard('awaitingReview', {
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['uncommitted'] },
      intention: {
        prompt: 'Normalize audio.',
        summary: 'Normalized loops.',
        tasks: [],
        commentary: [],
      },
    });
    renderWithMantine(<MissionCard {...baseProps({ card, onReview })} />);

    expect(screen.getByText('uncommitted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge → main' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ workflow: 'commit' }));
  });
});

describe('MissionCard — in progress', () => {
  it('renders the live task machinery and commentary, and no action row', () => {
    const card = makeCard('inProgress', {
      workspace: makeWorkspace({ instanceId: 'inst-2', branchName: 'agent/dialogue-docks' }),
      attention: { band: 'inProgress', needsYou: false, reasons: [] },
      session: {
        sessionId: 's',
        workspacePath: '/w',
        status: 'active',
        lastEventAt: 1,
        costUsd: 0.37,
      },
      intention: {
        prompt: 'Rewrite docks dialogue.',
        tasks: [
          { subject: 'Inventory lines', status: 'done' },
          { subject: 'Punch up barks', status: 'running', runningElapsedMs: 7 * 60_000 + 12_000 },
          { subject: 'Consistency pass', status: 'pending' },
        ],
        commentary: [
          { at: 1, text: 'Quest dialogue drafted.' },
          { at: 2, text: 'Barks trimmed to 10 words max.' },
        ],
      },
    });
    renderWithMantine(<MissionCard {...baseProps({ card })} />);

    expect(screen.getByText('Tasks · 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Punch up barks')).toBeInTheDocument();
    expect(screen.getByText('running 7m 12s')).toBeInTheDocument();
    expect(screen.getByText('Recent commentary')).toBeInTheDocument();
    expect(screen.getByText('Barks trimmed to 10 words max.')).toBeInTheDocument();
    expect(screen.getByText('$0.37')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge → main' })).not.toBeInTheDocument();
  });
});

describe('MissionCard — active workspace (packet U3)', () => {
  it('is unmarked and fully interactive by default', () => {
    renderWithMantine(<MissionCard {...baseProps()} />);

    expect(screen.queryByText('active')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close workspace/ })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Forget workspace/ })).not.toBeDisabled();
  });

  it('shows an active badge and disables ✕ and Forget with an explanatory title', async () => {
    const user = userEvent.setup();
    const onTeardown = jest.fn();
    const onForget = jest.fn();
    const card = makeCard('awaitingReview', {
      isActive: true,
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
    });
    renderWithMantine(<MissionCard {...baseProps({ card, onTeardown, onForget })} />);

    expect(screen.getByText('active')).toBeInTheDocument();

    const closeButton = screen.getByRole('button', { name: /Close workspace/ });
    const forgetButton = screen.getByRole('button', { name: /Forget workspace/ });
    expect(closeButton).toBeDisabled();
    expect(forgetButton).toBeDisabled();
    expect(closeButton).toHaveAttribute('title', expect.stringContaining('currently in'));
    expect(forgetButton).toHaveAttribute('title', expect.stringContaining('currently in'));

    // Disabled buttons never dispatch.
    await user.click(closeButton).catch(() => undefined);
    await user.click(forgetButton).catch(() => undefined);
    expect(onTeardown).not.toHaveBeenCalled();
    expect(onForget).not.toHaveBeenCalled();
  });

  it('dispatches Forget with the card for a non-active workspace', async () => {
    const user = userEvent.setup();
    const onForget = jest.fn();
    renderWithMantine(<MissionCard {...baseProps({ onForget })} />);

    await user.click(screen.getByRole('button', { name: /Forget workspace/ }));
    expect(onForget).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
  });
});

describe('MissionCard — title is the workspace name, branch is secondary', () => {
  it('titles the card by the workspace name and shows the branch as a muted secondary identifier', () => {
    // Given: two attached workspaces of one repo can share a branch name
    // ("adfa") while being registered under distinct names — Mission Control
    // is PRIMARILY keyed by workspace name, so the title must be the name,
    // not the branch, for the rows to be tellable apart.
    const card = makeCard('awaitingReview', {
      workspace: makeWorkspace({ branchName: 'adfa', name: 'personal-test' }),
    });
    renderWithMantine(<MissionCard {...baseProps({ card })} />);

    expect(screen.getByText('personal-test')).toBeInTheDocument();
    expect(screen.getByText('on adfa')).toBeInTheDocument();
  });

  it('still shows the branch secondary when the name and branch are the same string', () => {
    // Given: a provisioned worktree whose registry name is a sanitized
    // version of its branch (slashes replaced with hyphens) — name and
    // branch read as "the same idea" here, but the branch secondary still
    // renders unconditionally (consistency over cleverness: no collapsing
    // logic to get wrong).
    const card = makeCard('awaitingReview', {
      workspace: makeWorkspace({ branchName: 'test/WT1', name: 'test-WT1' }),
    });
    renderWithMantine(<MissionCard {...baseProps({ card })} />);

    expect(screen.getByText('test-WT1')).toBeInTheDocument();
    expect(screen.getByText('on test/WT1')).toBeInTheDocument();
  });
});

describe('MissionCard — degraded (hookless)', () => {
  it('renders no fabricated agent fields but keeps Lore-derived data and actions', () => {
    const card = makeCard('awaitingReview', {
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['unpushed'] },
      // no session, no intention
    });
    renderWithMantine(<MissionCard {...baseProps({ card })} />);

    expect(screen.queryByText('Agent:')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent commentary')).not.toBeInTheDocument();
    expect(screen.queryByText(/Tasks ·/)).not.toBeInTheDocument();
    // Lore-derived data still shows.
    expect(screen.getByText('Workspace · 3 files · +38 −21')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge → main' })).toBeInTheDocument();
  });
});
