import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MissionControlView } from '../../../src/renderer/components/mission-control/MissionControlView';
import type { MissionControlViewProps } from '../../../src/renderer/components/mission-control/MissionControlView';
import { makeCard, makeRepository, makeWorkspace, renderWithMantine } from './fixtures';

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
    onTeardown: jest.fn().mockResolvedValue(undefined),
    onProvision: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('MissionControlView — banding', () => {
  it('renders all three bands with counts and the workspace tally', () => {
    renderWithMantine(<MissionControlView {...baseProps()} />);

    expect(screen.getByText('Awaiting review · 1')).toBeInTheDocument();
    expect(screen.getByText('In progress · 1')).toBeInTheDocument();
    expect(screen.getByText('Idle · 1')).toBeInTheDocument();
    expect(screen.getByText('3 workspaces · this repo only')).toBeInTheDocument();

    // The idle workspace renders as a minimized row, not a full card.
    expect(screen.getByTestId('idle-workspace-row')).toBeInTheDocument();
    expect(screen.getAllByTestId('mission-card')).toHaveLength(2);
  });

  it('shows an empty state when the repository has no workspaces', () => {
    renderWithMantine(<MissionControlView {...baseProps({ cards: [] })} />);
    expect(screen.getByText(/No workspaces in this repository/)).toBeInTheDocument();
    expect(screen.getByText('0 workspaces · this repo only')).toBeInTheDocument();
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
            makeRepository({ id: OTHER_REPO_ID, name: 'brackwater' }),
          ],
          onSelectRepository,
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Switch repository' }));
    await user.click(await screen.findByRole('menuitem', { name: 'brackwater' }));

    expect(onSelectRepository).toHaveBeenCalledWith(OTHER_REPO_ID);
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
