import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MissionControlView } from '../../../src/renderer/components/mission-control/MissionControlView';
import type { MissionControlViewProps } from '../../../src/renderer/components/mission-control/MissionControlView';
import { makeCard, makeRepository, makeWorkspace, renderWithMantine } from './fixtures';

// The repo-switcher Menu opens through a floating-ui positioning pass; under
// heavy parallel test load that occasionally exceeds Jest's default 5s test
// timeout even though the interaction is correct — same headroom as
// MiniPlayer's picker tests.
jest.setTimeout(15000);

const OTHER_REPO_ID = '22222222-2222-4222-8222-222222222222';

function threeBands() {
  return [
    makeCard('awaitingReview', {
      workspace: makeWorkspace({ instanceId: 'a', branchName: 'agent/act2-balance' }),
      attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
      intention: { prompt: 'p', summary: 's', tasks: [], commentary: [] },
    }),
    makeCard('inProgress', {
      workspace: makeWorkspace({ instanceId: 'b', branchName: 'agent/dialogue' }),
      attention: { band: 'inProgress', needsYou: false, reasons: [] },
      intention: { tasks: [{ subject: 't', status: 'running' }], commentary: [] },
    }),
    makeCard('idle', {
      workspace: makeWorkspace({ instanceId: 'c', branchName: 'spike/old-fog' }),
      attention: { band: 'idle', needsYou: false, reasons: [] },
    }),
  ];
}

function baseProps(overrides: Partial<MissionControlViewProps> = {}): MissionControlViewProps {
  return {
    repositories: [makeRepository()],
    selectedRepositoryId: makeRepository().id,
    baseBranch: 'main',
    cards: threeBands(),
    onSelectRepository: jest.fn(),
    onOpenTerminal: jest.fn(),
    onReview: jest.fn(),
    onMarkActive: jest.fn(),
    onForget: jest.fn(),
    onTeardown: jest.fn().mockResolvedValue(undefined),
    onProvision: jest.fn().mockResolvedValue(undefined),
    onRefresh: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('MissionControlView — banding', () => {
  it('renders all three bands with counts and the workspace tally', () => {
    renderWithMantine(<MissionControlView {...baseProps()} />);

    expect(screen.getByText('Awaiting review · 1')).toBeInTheDocument();
    expect(screen.getByText('In progress · 1')).toBeInTheDocument();
    expect(screen.getByText('Idle · 1')).toBeInTheDocument();
    expect(screen.getByText('3 workspaces')).toBeInTheDocument();

    // The idle workspace renders as a minimized row, not a full card.
    expect(screen.getByTestId('idle-workspace-row')).toBeInTheDocument();
    expect(screen.getAllByTestId('mission-card')).toHaveLength(2);
  });

  it('shows an empty state when the repository has no workspaces', () => {
    renderWithMantine(<MissionControlView {...baseProps({ cards: [] })} />);
    expect(screen.getByText(/No workspaces in this repository/)).toBeInTheDocument();
    expect(screen.getByText('0 workspaces')).toBeInTheDocument();
  });
});

describe('MissionControlView — repo switcher', () => {
  it('switches the scoped repository', async () => {
    const user = userEvent.setup();
    const onSelectRepository = jest.fn();
    renderWithMantine(
      <MissionControlView
        {...baseProps({
          repositories: [
            makeRepository(),
            makeRepository({
              id: OTHER_REPO_ID,
              name: 'brackwater',
              url: 'lore://host/brackwater',
            }),
          ],
          onSelectRepository,
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Switch repository' }));
    // hidden:true + extended timeout: floating-ui transitions the dropdown
    // through display:none while positioning under parallel test load.
    await user.click(
      await screen.findByRole('menuitem', { name: 'brackwater', hidden: true }, { timeout: 8000 })
    );

    expect(onSelectRepository).toHaveBeenCalledWith(OTHER_REPO_ID);
  });

  it('lists repos, not workspace entries — an attached sibling of the same repo (e.g. "adfa") collapses into one option', async () => {
    const user = userEvent.setup();
    const anchor = makeRepository({ name: 'demo-project', url: 'lore://host/demo-project' });
    const sibling = makeRepository({
      id: OTHER_REPO_ID,
      name: 'adfa',
      url: 'lore://host/demo-project',
    });
    renderWithMantine(
      <MissionControlView
        {...baseProps({
          repositories: [anchor, sibling],
          selectedRepositoryId: anchor.id,
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Switch repository' }));

    // One switcher option for the repo, named from the url — not two entries
    // ("demo-project" and "adfa") for what is really one repo.
    expect(await screen.findByRole('menuitem', { name: 'demo-project' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'adfa' })).not.toBeInTheDocument();
  });
});

describe('MissionControlView — teardown flow', () => {
  it('opens the confirm modal from a card ✕ and tears down on confirm', async () => {
    const user = userEvent.setup();
    const onTeardown = jest.fn().mockResolvedValue(undefined);
    renderWithMantine(<MissionControlView {...baseProps({ onTeardown })} />);

    const card = screen.getAllByTestId('mission-card')[0]!;
    await user.click(within(card).getByRole('button', { name: /Close workspace/ }));

    // Modal is open; the awaiting-review card is clean so no force is required.
    const confirm = await screen.findByRole('button', { name: 'Close workspace' });
    await user.click(confirm);

    expect(onTeardown).toHaveBeenCalledWith('a', false);
  });
});

describe('MissionControlView — provision flow', () => {
  it('opens the provision modal and dispatches the new branch name', async () => {
    const user = userEvent.setup();
    const onProvision = jest.fn().mockResolvedValue(undefined);
    renderWithMantine(<MissionControlView {...baseProps({ onProvision })} />);

    await user.click(screen.getByRole('button', { name: /Provision workspace/ }));
    await user.type(await screen.findByLabelText('New branch name'), 'agent/new');
    await user.click(screen.getByRole('button', { name: 'Provision' }));

    expect(onProvision).toHaveBeenCalledWith('agent/new');
  });
});

describe('MissionControlView — idle actions', () => {
  it('marks an idle workspace active', async () => {
    const user = userEvent.setup();
    const onMarkActive = jest.fn();
    renderWithMantine(<MissionControlView {...baseProps({ onMarkActive })} />);

    await user.click(screen.getByRole('button', { name: 'Mark active' }));
    expect(onMarkActive).toHaveBeenCalledWith('c');
  });

  it('tears down an idle workspace (never force-required) from its row ✕', async () => {
    const user = userEvent.setup();
    const onTeardown = jest.fn().mockResolvedValue(undefined);
    renderWithMantine(<MissionControlView {...baseProps({ onTeardown })} />);

    const idleRow = screen.getByTestId('idle-workspace-row');
    await user.click(within(idleRow).getByRole('button', { name: /Close workspace/ }));
    const confirm = await screen.findByRole('button', { name: 'Close workspace' });
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);
    expect(onTeardown).toHaveBeenCalledWith('c', false);
  });
});

describe('MissionControlView — forget (packet U3)', () => {
  it('forgets a workspace from a full card', async () => {
    const user = userEvent.setup();
    const onForget = jest.fn();
    renderWithMantine(<MissionControlView {...baseProps({ onForget })} />);

    const card = screen.getAllByTestId('mission-card')[0]!;
    await user.click(within(card).getByRole('button', { name: /Forget workspace/ }));

    expect(onForget).toHaveBeenCalledWith('a');
  });

  it('forgets a workspace from an idle row', async () => {
    const user = userEvent.setup();
    const onForget = jest.fn();
    renderWithMantine(<MissionControlView {...baseProps({ onForget })} />);

    const idleRow = screen.getByTestId('idle-workspace-row');
    await user.click(within(idleRow).getByRole('button', { name: /Forget workspace/ }));

    expect(onForget).toHaveBeenCalledWith('c');
  });
});

describe('MissionControlView — active workspace (packet U3)', () => {
  it('marks the active card and disables its ✕ and Forget without opening the teardown modal', async () => {
    const user = userEvent.setup();
    const onTeardown = jest.fn().mockResolvedValue(undefined);
    const cards = threeBands();
    const [awaitingCard] = cards;
    const activeCards = [{ ...awaitingCard!, isActive: true }, ...cards.slice(1)];
    renderWithMantine(<MissionControlView {...baseProps({ cards: activeCards, onTeardown })} />);

    const card = screen.getAllByTestId('mission-card')[0]!;
    expect(within(card).getByText('active')).toBeInTheDocument();

    const closeButton = within(card).getByRole('button', { name: /Close workspace/ });
    expect(closeButton).toBeDisabled();

    await user.click(closeButton).catch(() => undefined);
    expect(screen.queryByRole('button', { name: 'Close workspace' })).not.toBeInTheDocument();
    expect(onTeardown).not.toHaveBeenCalled();
  });
});

describe('MissionControlView — manual refresh', () => {
  it('invokes onRefresh when the header refresh control is clicked', async () => {
    const user = userEvent.setup();
    const onRefresh = jest.fn().mockResolvedValue(undefined);
    renderWithMantine(<MissionControlView {...baseProps({ onRefresh })} />);

    await user.click(screen.getByRole('button', { name: 'Refresh workspaces' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows a busy loading state while the refresh is in flight, then clears it', async () => {
    const user = userEvent.setup();
    let resolveRefresh: () => void = () => undefined;
    const onRefresh = jest.fn(
      () =>
        new Promise<void>(resolve => {
          resolveRefresh = resolve;
        })
    );
    renderWithMantine(<MissionControlView {...baseProps({ onRefresh })} />);

    const button = screen.getByRole('button', { name: 'Refresh workspaces' });
    await user.click(button);

    expect(button).toHaveAttribute('aria-busy', 'true');

    resolveRefresh();
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy', 'true'));
  });

  it('clears the loading state when the refresh rejects, without throwing', async () => {
    const user = userEvent.setup();
    const onRefresh = jest.fn().mockRejectedValue(new Error('refresh failed'));
    renderWithMantine(<MissionControlView {...baseProps({ onRefresh })} />);

    const button = screen.getByRole('button', { name: 'Refresh workspaces' });
    await user.click(button);

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy', 'true'));
  });
});

describe('MissionControlView — resilience', () => {
  it('renders only the bands that have workspaces', () => {
    const onlyAwaiting = [
      makeCard('awaitingReview', {
        workspace: makeWorkspace({ instanceId: 'a', branchName: 'agent/solo' }),
        attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
        intention: { prompt: 'p', summary: 's', tasks: [], commentary: [] },
      }),
    ];
    renderWithMantine(<MissionControlView {...baseProps({ cards: onlyAwaiting })} />);

    expect(screen.getByText('Awaiting review · 1')).toBeInTheDocument();
    expect(screen.queryByText(/In progress/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Idle ·/)).not.toBeInTheDocument();
  });

  it('keeps the teardown modal open when the operation fails', async () => {
    const user = userEvent.setup();
    const onTeardown = jest.fn().mockRejectedValue(new Error('nope'));
    renderWithMantine(<MissionControlView {...baseProps({ onTeardown })} />);

    const card = screen.getAllByTestId('mission-card')[0]!;
    await user.click(within(card).getByRole('button', { name: /Close workspace/ }));
    const confirm = await screen.findByRole('button', { name: 'Close workspace' });
    await user.click(confirm);

    await waitFor(() => expect(onTeardown).toHaveBeenCalled());
    // The modal stays open (its confirm button is still present) so the user can retry.
    expect(screen.getByRole('button', { name: 'Close workspace' })).toBeInTheDocument();
  });
});
