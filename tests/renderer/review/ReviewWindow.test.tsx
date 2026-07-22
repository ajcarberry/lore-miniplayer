jest.mock('@mantine/notifications', () => ({ notifications: { show: jest.fn() } }));

import { notifications } from '@mantine/notifications';
import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewWindow } from '../../../src/renderer/components/review/ReviewWindow';
import { installMockElectronAPI } from '../../mocks/electron-api';
import type {
  FileDiffResult,
  LoreFileStatusGroup,
  ReviewOpenRequest,
} from '../../../src/shared/types';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_PATH = '/wt/act2-balance';

function makeRequest(overrides: Partial<ReviewOpenRequest> = {}): ReviewOpenRequest {
  return {
    workspacePath: WORKSPACE_PATH,
    repositoryId: REPO_ID,
    branchName: 'agent/act2-balance',
    revision: 'r128',
    workflow: 'commit',
    compare: {
      source: { kind: 'revision', revision: 'r128' },
      target: { kind: 'workingTree' },
    },
    title: 'Balance pass',
    ...overrides,
  };
}

const DIFFS: FileDiffResult[] = [
  {
    path: 'encounters.toml',
    action: 'modified',
    patch:
      '@@ -38,2 +38,3 @@ [enc.ravine]\n [enc.ravine.ambush]\n-elite_count = 2\n+elite_count = 4\n+elite_spawn_delay = 6.0\n',
    binary: false,
    truncated: false,
    lineStats: { added: 14, removed: 9 },
  },
  {
    path: 'conflict.toml',
    action: 'modified',
    patch: '@@ -1 +1 @@\n-a\n+b\n',
    binary: false,
    truncated: false,
    lineStats: { added: 1, removed: 1 },
  },
  {
    path: 'loot_tables.bin',
    action: 'modified',
    binary: true,
    truncated: false,
  },
  {
    path: 'big.toml',
    action: 'modified',
    patch: '@@ -1 +1 @@\n-x\n+y\n',
    binary: false,
    truncated: true,
    lineStats: { added: 1, removed: 1 },
  },
];

function status(): LoreFileStatusGroup {
  return {
    untracked: [],
    unstaged: [
      {
        path: 'conflict.toml',
        isUntracked: false,
        isStaged: false,
        conflict: true,
        conflictUnresolved: true,
      },
      { path: 'loot_tables.bin', isUntracked: false, isStaged: false, conflict: false },
      { path: 'big.toml', isUntracked: false, isStaged: false, conflict: false },
    ],
    staged: [{ path: 'encounters.toml', isUntracked: false, isStaged: true, conflict: false }],
  };
}

interface Api {
  requestContext: jest.Mock;
  onContext: jest.Mock;
  compare: jest.Mock;
  getStatus: jest.Mock;
  stage: jest.Mock;
  unstage: jest.Mock;
  commit: jest.Mock;
  push: jest.Mock;
}

function installApi(request: ReviewOpenRequest = makeRequest()): Api {
  const api = installMockElectronAPI();
  const requestContext = jest.fn().mockResolvedValue({ success: true, data: request });
  const onContext = jest.fn().mockReturnValue(jest.fn());
  const compare = jest.fn().mockResolvedValue({ success: true, data: DIFFS });
  const getStatus = jest.fn().mockResolvedValue({ success: true, data: status() });
  const stage = jest.fn().mockResolvedValue({ success: true, data: undefined });
  const unstage = jest.fn().mockResolvedValue({ success: true, data: undefined });
  const commit = jest.fn().mockResolvedValue({ success: true, data: undefined });
  const push = jest.fn().mockResolvedValue({ success: true, data: undefined });

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
        name: 'agent/act2-balance',
        revisions: [
          { revision: 'r130', revisionNumber: 130, message: 'Flatten pacing' },
          { revision: 'r129', revisionNumber: 129, message: 'Retune ambush' },
        ],
      },
      mergesFromParent: [],
      mergesToParent: [],
    },
  });
  api.lore.files.getStatus = getStatus;
  api.lore.files.stage = stage;
  api.lore.files.unstage = unstage;
  api.lore.repository.commit = commit;
  api.lore.repository.push = push;
  Object.assign(api, {
    review: { open: jest.fn(), requestContext, onContext },
    diff: { compare },
    // The merge routing test drives a clean (conflict-free) merge so the merge
    // view renders its header without needing conflict content.
    merge: {
      start: jest.fn().mockResolvedValue({
        success: true,
        data: {
          sourceBranch: 'agent/act2-balance',
          targetBranch: 'main',
          allResolved: true,
          hasChangesToLand: true,
          files: [{ path: 'encounters.toml', state: 'merged' }],
        },
      }),
      resolve: jest.fn(),
      abort: jest.fn(),
      complete: jest.fn(),
    },
  });

  return { requestContext, onContext, compare, getStatus, stage, unstage, commit, push };
}

function renderWindow(): void {
  render((<MantineProvider>{<ReviewWindow />}</MantineProvider>) as ReactElement);
}

describe('ReviewWindow — commit workflow', () => {
  it('renders the three-pane layout from the diff + status snapshot', async () => {
    installApi();
    renderWindow();

    // Title + eyebrow (repo · branch)
    expect(await screen.findByText('Review — Balance pass')).toBeInTheDocument();
    expect(screen.getByText('emberfall · agent/act2-balance')).toBeInTheDocument();

    // File list header aggregates the line stats across files.
    expect(screen.getByText(/4 files · \+16 −11 · stage for commit/)).toBeInTheDocument();
    expect(screen.getByText('encounters.toml')).toBeInTheDocument();

    // Center pane shows the first file's diff by default (added line, "+ " marker).
    expect(await screen.findByText(/elite_count = 4/)).toBeInTheDocument();
  });

  it('drives a refetch when the compare picker changes the source revision', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderWindow();
    await screen.findByText('encounters.toml');

    await user.click(screen.getByLabelText('Change compare source'));
    await user.click(await screen.findByText('r129 · Retune ambush'));

    await waitFor(() => {
      expect(api.compare).toHaveBeenLastCalledWith(
        expect.objectContaining({
          repositoryPath: WORKSPACE_PATH,
          source: { kind: 'revision', revision: 'r129' },
        })
      );
    });
  });

  it('stages a file through the staging IPC when its checkbox is toggled', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderWindow();
    await screen.findByText('big.toml');

    // big.toml starts unstaged; checking it stages it.
    await user.click(screen.getByLabelText('Stage big.toml'));
    expect(api.stage).toHaveBeenCalledWith(WORKSPACE_PATH, ['big.toml']);

    // encounters.toml starts staged; unchecking it unstages it.
    await user.click(screen.getByLabelText('Stage encounters.toml'));
    expect(api.unstage).toHaveBeenCalledWith(WORKSPACE_PATH, ['encounters.toml']);
  });

  it('disables staging for an unresolved conflict, flagging it instead', async () => {
    installApi();
    renderWindow();
    await screen.findByText('conflict.toml');

    // No stage checkbox for the conflicted file; a warning marks it.
    expect(screen.queryByLabelText('Stage conflict.toml')).not.toBeInTheDocument();
    expect(screen.getByLabelText('conflict.toml has an unresolved conflict')).toBeInTheDocument();
  });

  it('gates Commit on a message and a staged file', async () => {
    installApi();
    const user = userEvent.setup();
    renderWindow();
    await screen.findByText('encounters.toml');

    // A file is staged (encounters.toml) but the message is empty initially?
    // The title preloads a message, so clear it to prove the gate.
    const message = screen.getByLabelText('Commit message');
    await user.clear(message);
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();

    await user.type(message, 'Balance pass on Act II');
    expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled();
  });

  it('commits the staged files then offers Push', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderWindow();
    await screen.findByText('encounters.toml');

    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(api.commit).toHaveBeenCalledWith(WORKSPACE_PATH, 'Balance pass');

    // Post-commit the one contextual action becomes Push.
    const push = await screen.findByRole('button', { name: 'Push' });
    await user.click(push);
    expect(api.push).toHaveBeenCalledWith(WORKSPACE_PATH);
  });

  it('shows binary and truncation notices for the relevant files', async () => {
    installApi();
    const user = userEvent.setup();
    renderWindow();
    await screen.findByText('loot_tables.bin');

    await user.click(screen.getByText('loot_tables.bin'));
    expect(await screen.findByText(/Binary file/)).toBeInTheDocument();

    await user.click(screen.getByText('big.toml'));
    expect(await screen.findByText('Diff truncated')).toBeInTheDocument();
  });

  it('surfaces error notices when diff, staging, commit, and push all fail', async () => {
    const api = installApi();
    // Fail every operation the commit workflow can invoke.
    api.compare.mockResolvedValue({ success: false, error: 'diff boom' });
    api.getStatus.mockResolvedValue({ success: false, error: 'status boom' });
    api.stage.mockResolvedValue({ success: false, error: 'stage boom' });
    api.commit.mockResolvedValue({ success: false, error: 'commit boom' });
    api.push.mockResolvedValue({ success: false, error: 'push boom' });

    renderWindow();

    // With a failed diff there are no files; the empty diff pane prompts a select.
    expect(await screen.findByText('Select a file to view its diff')).toBeInTheDocument();
    await waitFor(() => expect(notifications.show).toHaveBeenCalled());
  });

  it('recovers from a failed staging call without crashing', async () => {
    const api = installApi();
    const user = userEvent.setup();
    // Diff/status succeed so the list renders, but staging fails.
    api.stage.mockResolvedValue({ success: false, error: 'stage boom' });
    renderWindow();
    await screen.findByText('big.toml');

    await user.click(screen.getByLabelText('Stage big.toml'));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Stage failed' })
      )
    );
  });
});

describe('ReviewWindow — merge workflow routing', () => {
  it('routes the merge workflow to the merge view without the commit compare picker', async () => {
    installApi(
      makeRequest({
        workflow: 'merge',
        compare: {
          source: { kind: 'branchHead', branch: 'agent/act2-balance' },
          target: { kind: 'branchHead', branch: 'main' },
        },
      })
    );
    renderWindow();

    expect(await screen.findByText('Merge — agent/act2-balance → main')).toBeInTheDocument();
    expect(screen.queryByLabelText('Change compare source')).not.toBeInTheDocument();
  });
});
