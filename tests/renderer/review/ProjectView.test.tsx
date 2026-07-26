jest.mock('@mantine/notifications', () => ({ notifications: { show: jest.fn() } }));

import { notifications } from '@mantine/notifications';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectView } from '../../../src/renderer/components/review/ProjectView';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { renderWithMantine } from '../test-utils';
import { makeReviewRequest, REPO_ID } from './fixtures';
import type {
  FileDiffResult,
  LoreFileStatusGroup,
  ReviewOpenRequest,
} from '../../../src/shared/types';

const WORKSPACE_PATH = '/repos/my-repo';

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
  compare: jest.Mock;
  getStatus: jest.Mock;
  stage: jest.Mock;
  unstage: jest.Mock;
  commit: jest.Mock;
  push: jest.Mock;
}

function installApi(): Api {
  const api = installMockElectronAPI();
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
        name: 'feat/topic',
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
    diff: { compare },
    // The merge routing test drives a clean (conflict-free) merge so the merge
    // view renders its header without needing conflict content.
    merge: {
      start: jest.fn().mockResolvedValue({
        success: true,
        data: {
          sourceBranch: 'feat/topic',
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

  return { compare, getStatus, stage, unstage, commit, push };
}

function renderSurface(
  request: ReviewOpenRequest = makeReviewRequest(),
  onExit: () => void = jest.fn(),
  onCollapse: () => void = jest.fn()
): void {
  renderWithMantine(<ProjectView request={request} onExit={onExit} onCollapse={onCollapse} />);
}

describe('ProjectView — commit workflow', () => {
  it('renders the three-pane layout from the diff + status snapshot', async () => {
    installApi();
    renderSurface();

    // Title + eyebrow (repo · branch)
    expect(await screen.findByText('Review — feat/topic')).toBeInTheDocument();
    expect(await screen.findByText('emberfall · feat/topic')).toBeInTheDocument();

    // File list header aggregates the line stats across files.
    expect(screen.getByText(/4 files · \+16 −11 · stage for commit/)).toBeInTheDocument();
    expect(screen.getByText('encounters.toml')).toBeInTheDocument();

    // Center pane shows the first file's diff by default (added line, "+ " marker).
    expect(await screen.findByText(/elite_count = 4/)).toBeInTheDocument();
  });

  it('drives a refetch when the compare picker changes the source revision', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderSurface();
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
    renderSurface();
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
    renderSurface();
    await screen.findByText('conflict.toml');

    // No stage checkbox for the conflicted file; a warning marks it.
    expect(screen.queryByLabelText('Stage conflict.toml')).not.toBeInTheDocument();
    expect(screen.getByLabelText('conflict.toml has an unresolved conflict')).toBeInTheDocument();
  });

  it('gates Commit on a message and a staged file', async () => {
    installApi();
    const user = userEvent.setup();
    renderSurface();
    await screen.findByText('encounters.toml');

    // A file is staged (encounters.toml) but the message starts empty, so the
    // gate holds until a message is typed.
    const message = screen.getByLabelText('Commit message');
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();

    await user.type(message, 'Balance pass on Act II');
    expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled();
  });

  it('commits the staged files then offers Push', async () => {
    const api = installApi();
    const user = userEvent.setup();
    renderSurface();
    await screen.findByText('encounters.toml');

    await user.type(screen.getByLabelText('Commit message'), 'Balance pass');
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
    renderSurface();
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

    renderSurface();

    // With a failed diff there are no files; the empty diff pane prompts a select.
    expect(await screen.findByText('Select a file to view its diff')).toBeInTheDocument();
    await waitFor(() => expect(notifications.show).toHaveBeenCalled());
  });

  it('notifies when the commit itself fails, leaving the bar on Commit', async () => {
    const api = installApi();
    const user = userEvent.setup();
    // Diff/status succeed so a file is staged and the gate can open; only the
    // commit call fails — the branch the all-fail test above can never reach,
    // because a failed diff leaves nothing staged to commit.
    api.commit.mockResolvedValue({ success: false, error: 'commit boom' });
    renderSurface();
    await screen.findByText('encounters.toml');

    await user.type(screen.getByLabelText('Commit message'), 'Balance pass');
    await user.click(screen.getByRole('button', { name: 'Commit' }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Commit failed', message: 'commit boom' })
      )
    );
    // The workflow never advanced: no Push action was offered.
    expect(screen.queryByRole('button', { name: 'Push' })).not.toBeInTheDocument();
  });

  it('notifies when the post-commit push fails', async () => {
    const api = installApi();
    const user = userEvent.setup();
    // The commit lands (so Push is offered at all); the push then fails.
    api.push.mockResolvedValue({ success: false, error: 'push boom' });
    renderSurface();
    await screen.findByText('encounters.toml');

    await user.type(screen.getByLabelText('Commit message'), 'Balance pass');
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    await user.click(await screen.findByRole('button', { name: 'Push' }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Push failed', message: 'push boom' })
      )
    );
  });

  it('recovers from a failed staging call without crashing', async () => {
    const api = installApi();
    const user = userEvent.setup();
    // Diff/status succeed so the list renders, but staging fails.
    api.stage.mockResolvedValue({ success: false, error: 'stage boom' });
    renderSurface();
    await screen.findByText('big.toml');

    await user.click(screen.getByLabelText('Stage big.toml'));
    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Stage failed' })
      )
    );
  });
});

describe('ProjectView — merge workflow routing', () => {
  it('routes the merge workflow to the merge view without the commit compare picker', async () => {
    installApi();
    renderSurface(
      makeReviewRequest({
        workflow: 'merge',
        compare: {
          source: { kind: 'branchHead', branch: 'feat/topic' },
          target: { kind: 'branchHead', branch: 'main' },
        },
      })
    );

    expect(await screen.findByText('Merge — feat/topic → main')).toBeInTheDocument();
    expect(screen.queryByLabelText('Change compare source')).not.toBeInTheDocument();
  });
});

describe('ProjectView — back to the card and down to the pill', () => {
  it('exits the commit workflow through the header back control', async () => {
    installApi();
    const onExit = jest.fn();
    const user = userEvent.setup();
    renderSurface(makeReviewRequest(), onExit);
    await screen.findByText('Review — feat/topic');

    // When: clicking Back in the header
    await user.click(screen.getByLabelText('Back'));

    // Then: the view hands control back to the card
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('collapses straight to the pill through the TitleBar control', async () => {
    installApi();
    const onCollapse = jest.fn();
    const user = userEvent.setup();
    renderSurface(makeReviewRequest(), jest.fn(), onCollapse);
    await screen.findByText('Review — feat/topic');

    // When: clicking the TitleBar's collapse control
    await user.click(screen.getByLabelText('Collapse to pill'));

    // Then: the view asks to collapse to the ambient pill
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
