jest.mock('@mantine/notifications', () => ({ notifications: { show: jest.fn() } }));

import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MissionControl } from '../../../src/renderer/components/mission-control/MissionControl';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeCard, makeRepository, makeWorkspace, REPO_ID } from './fixtures';
import type { WorkspaceModelSnapshot } from '../../../src/shared/types';

const OTHER_REPO_ID = '44444444-4444-4444-8444-444444444444';

function snapshot(): WorkspaceModelSnapshot {
  return {
    repositoryId: REPO_ID,
    cards: [
      makeCard('awaitingReview', {
        attention: { band: 'awaitingReview', needsYou: true, reasons: ['reviewReady'] },
        intention: { prompt: 'p', summary: 's', tasks: [], commentary: [] },
      }),
      makeCard('idle', {
        workspace: makeWorkspace({ instanceId: 'c', branchName: 'spike/old-fog', path: '/wt/fog' }),
        attention: { band: 'idle', needsYou: false, reasons: [] },
      }),
    ],
  };
}

interface Api {
  watch: jest.Mock;
  teardown: jest.Mock;
  provision: jest.Mock;
  markActive: jest.Mock;
  openTerminal: jest.Mock;
  refresh: jest.Mock;
}

function installApi(repositories = [makeRepository()]): Api {
  const api = installMockElectronAPI();
  const watch = jest.fn().mockResolvedValue({ success: true, data: snapshot() });
  const teardown = jest.fn().mockResolvedValue({ success: true, data: {} });
  const provision = jest.fn().mockResolvedValue({ success: true, data: {} });
  const markActive = jest.fn().mockResolvedValue({ success: true, data: {} });
  const openTerminal = jest.fn().mockResolvedValue({ success: true, data: undefined });
  const refresh = jest.fn().mockResolvedValue({ success: true, data: undefined });
  api.repository.list = jest.fn().mockResolvedValue({ success: true, data: repositories });
  api.lore.repository.listBranches = jest
    .fn()
    .mockResolvedValue({
      success: true,
      data: [{ name: 'main', isDefault: true, isCurrent: true }],
    });
  api.window.openTerminal = openTerminal;
  Object.assign(api, {
    missionControl: {
      open: jest.fn(),
      close: jest.fn(),
      watch,
      onSnapshot: jest.fn(() => jest.fn()),
      refresh,
    },
    workspace: { provision, list: jest.fn(), teardown, markActive },
  });
  return { watch, teardown, provision, markActive, openTerminal, refresh };
}

function renderContainer(): void {
  render((<MantineProvider>{<MissionControl />}</MantineProvider>) as ReactElement);
}

describe('MissionControl container', () => {
  it('loads the selected repo and renders its banded workspaces', async () => {
    installApi();
    renderContainer();
    expect(await screen.findByText('agent/act2-balance')).toBeInTheDocument();
    expect(screen.getByText('spike/old-fog')).toBeInTheDocument();
  });

  it('opens a terminal in the workspace directory', async () => {
    const user = userEvent.setup();
    const api = installApi();
    renderContainer();

    const card = await screen.findByTestId('mission-card');
    await user.click(within(card).getByRole('button', { name: 'Open terminal' }));
    expect(api.openTerminal).toHaveBeenCalledWith('/Users/rowan/work/emberfall-wt/act2-balance');
  });

  it('marks an idle workspace active', async () => {
    const user = userEvent.setup();
    const api = installApi();
    renderContainer();

    await user.click(await screen.findByRole('button', { name: 'Mark active' }));
    expect(api.markActive).toHaveBeenCalledWith({ workspaceId: 'c' });
  });

  it('tears down a workspace after confirmation', async () => {
    const user = userEvent.setup();
    const api = installApi();
    renderContainer();

    const card = await screen.findByTestId('mission-card');
    await user.click(within(card).getByRole('button', { name: /Close workspace/ }));
    await user.click(await screen.findByRole('button', { name: 'Close workspace' }));
    expect(api.teardown).toHaveBeenCalledWith({ workspaceId: 'inst-1', force: false });
  });

  it('provisions a new workspace on the selected repository', async () => {
    const user = userEvent.setup();
    const api = installApi();
    renderContainer();

    await user.click(await screen.findByRole('button', { name: /Provision workspace/ }));
    await user.type(await screen.findByLabelText('New branch name'), 'agent/new');
    await user.click(screen.getByRole('button', { name: 'Provision' }));

    expect(api.provision).toHaveBeenCalledWith({ repositoryId: REPO_ID, branchName: 'agent/new' });
  });

  it('manually refreshes the watched repository from the header control', async () => {
    const user = userEvent.setup();
    const api = installApi();
    renderContainer();

    await screen.findByText('agent/act2-balance');
    await user.click(screen.getByRole('button', { name: 'Refresh workspaces' }));
    expect(api.refresh).toHaveBeenCalledWith(REPO_ID);
  });

  it('surfaces a manual refresh failure as a notification', async () => {
    const user = userEvent.setup();
    const api = installApi();
    api.refresh.mockResolvedValue({ success: false, error: 'offline' });
    renderContainer();

    await screen.findByText('agent/act2-balance');
    await user.click(screen.getByRole('button', { name: 'Refresh workspaces' }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ color: 'red', title: 'Refresh failed', message: 'offline' })
      )
    );
  });

  it('re-watches the model when the scoped repository is switched', async () => {
    const user = userEvent.setup();
    const api = installApi([
      makeRepository(),
      makeRepository({ id: OTHER_REPO_ID, name: 'brackwater' }),
    ]);
    renderContainer();
    await waitFor(() => expect(api.watch).toHaveBeenCalledWith(REPO_ID));

    await user.click(screen.getByRole('button', { name: 'Switch repository' }));
    await user.click(await screen.findByRole('menuitem', { name: 'brackwater' }));
    await waitFor(() => expect(api.watch).toHaveBeenCalledWith(OTHER_REPO_ID));
  });
});
