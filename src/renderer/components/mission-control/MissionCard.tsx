import type { ReactElement } from 'react';
import { ActionIcon, Badge, Box, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconEyeOff, IconX } from '@tabler/icons-react';
import type { AgentTask, WorkspaceCard } from '../../../shared/types';
import { distinctWorkspaceName } from '../../utils/repository-name';
import type { OpenReviewIntent } from './reviewIntent';
import {
  deriveWorkspaceFlags,
  formatCommitAge,
  formatCost,
  formatElapsed,
  resolveCostUsd,
} from './format';

export interface MissionCardProps {
  readonly card: WorkspaceCard;
  readonly onOpenTerminal: (path: string) => void;
  readonly onTeardown: (card: WorkspaceCard) => void;
  readonly onReview: (intent: OpenReviewIntent) => void;
  // Untrack-only removal (design amendment) — the non-destructive
  // counterpart to onTeardown. Disabled for the active card, same as ✕.
  readonly onForget: (card: WorkspaceCard) => void;
}

const TASK_GLYPH: Record<AgentTask['status'], string> = {
  done: '✓',
  running: '▶',
  pending: '○',
};

// A full Mission Control card (design 2a), used in the Awaiting review and In
// progress bands. Awaiting-review cards carry the agent's summary + a
// contextual action row; in-progress cards carry the live task machinery +
// commentary. Degraded (hookless) workspaces have no intention, so no prompt,
// summary, tasks, or commentary render — no fabricated agent fields.
export function MissionCard({
  card,
  onOpenTerminal,
  onTeardown,
  onReview,
  onForget,
}: MissionCardProps): ReactElement {
  const { workspace, attention, isActive, intention, fileStats, changedFileCount, sessionCommits } =
    card;
  const inProgress = attention.band === 'inProgress';
  const flags = deriveWorkspaceFlags(card);
  const cost = formatCost(resolveCostUsd(card));

  const showTasks = inProgress && intention !== undefined && intention.tasks.length > 0;
  const showSummary = !inProgress && intention?.summary !== undefined;
  const showCommentary = inProgress && intention !== undefined && intention.commentary.length > 0;

  return (
    <Paper
      withBorder
      radius='md'
      p='md'
      data-testid='mission-card'
      data-band={attention.band}
      style={{ background: 'var(--paper-raised)' }}
    >
      <Stack gap='sm'>
        <CardHeader
          workspace={workspace}
          inProgress={inProgress}
          isActive={isActive}
          dirty={flags.dirty}
          cost={cost}
          onTeardown={() => onTeardown(card)}
          onForget={() => onForget(card)}
        />

        {intention?.prompt !== undefined && (
          <Text
            size='sm'
            fs='italic'
            ff='var(--font-disp)'
            style={{ background: 'var(--paper-sink)', borderRadius: 8, padding: '8px 11px' }}
          >
            {`“${intention.prompt}”`}
          </Text>
        )}

        {showTasks && <TaskList tasks={intention.tasks} />}
        {showSummary && (
          <Text size='sm'>
            <Text component='span' fw={600}>
              Agent:
            </Text>{' '}
            {intention.summary}
          </Text>
        )}

        <StatsAndCommits
          changedFileCount={changedFileCount}
          added={fileStats.added}
          removed={fileStats.removed}
          sessionCommits={sessionCommits}
        />

        {showCommentary && <Commentary card={card} />}

        {attention.band === 'awaitingReview' && (
          <CardActions
            workspace={workspace}
            dirty={flags.dirty}
            onReview={onReview}
            onOpenTerminal={onOpenTerminal}
          />
        )}
      </Stack>
    </Paper>
  );
}

function CardHeader({
  workspace,
  inProgress,
  isActive,
  dirty,
  cost,
  onTeardown,
  onForget,
}: {
  readonly workspace: WorkspaceCard['workspace'];
  readonly inProgress: boolean;
  readonly isActive: boolean;
  readonly dirty: boolean;
  readonly cost: string | null;
  readonly onTeardown: () => void;
  readonly onForget: () => void;
}): ReactElement {
  const activeTitle = isActive
    ? 'This is the workspace you are currently in — close or forget another one instead'
    : undefined;
  // Two registry entries can share a branch name while being distinct
  // workspaces (e.g. two attached checkouts both on "adfa") — surface the
  // registry name as a muted suffix whenever it isn't just the branch again.
  const distinctName = distinctWorkspaceName(workspace.name, workspace.branchName);

  return (
    <Group gap={8} wrap='nowrap'>
      <Box
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: inProgress ? 'var(--acc)' : 'transparent',
          border: inProgress ? undefined : '2px solid var(--acc-deep)',
          ...(inProgress ? { animation: 'pulseDot 2s infinite' } : {}),
        }}
      />
      {/* Branch — hover reveals the worktree directory (design 2a). */}
      <Text
        component='span'
        ff='var(--font-mono)'
        fw={600}
        size='sm'
        title={workspace.path}
        style={{ borderBottom: '1px dashed var(--hair)', cursor: 'help' }}
      >
        {workspace.branchName}
      </Text>
      {distinctName !== undefined && (
        <Text component='span' ff='var(--font-mono)' size='sm' c='dimmed'>
          {`· ${distinctName}`}
        </Text>
      )}
      {isActive && (
        <Badge color='blue' variant='light' size='sm'>
          active
        </Badge>
      )}
      {dirty ? (
        <Badge color='yellow' variant='light' size='sm'>
          uncommitted
        </Badge>
      ) : (
        <Text size='xs' c='dimmed' ff='var(--font-mono)'>
          clean
        </Text>
      )}
      {cost !== null && (
        <Text size='xs' c='dimmed' ff='var(--font-mono)'>
          {cost}
        </Text>
      )}
      <ActionIcon
        ml='auto'
        size='sm'
        variant='subtle'
        color='gray'
        aria-label={`Forget workspace ${workspace.branchName}`}
        title={activeTitle ?? 'Forget (stop tracking, keep the files)'}
        disabled={isActive}
        onClick={onForget}
      >
        <IconEyeOff size={14} />
      </ActionIcon>
      <ActionIcon
        size='sm'
        variant='subtle'
        color='gray'
        aria-label={`Close workspace ${workspace.branchName}`}
        title={activeTitle ?? 'Close workspace (removes the directory and archives the branch)'}
        disabled={isActive}
        onClick={onTeardown}
      >
        <IconX size={14} />
      </ActionIcon>
    </Group>
  );
}

function StatsAndCommits({
  changedFileCount,
  added,
  removed,
  sessionCommits,
}: {
  readonly changedFileCount: number;
  readonly added: number;
  readonly removed: number;
  readonly sessionCommits: WorkspaceCard['sessionCommits'];
}): ReactElement {
  return (
    <Group align='flex-start' gap='lg' grow>
      <Stack gap={2}>
        <Text size='xs' tt='uppercase' fw={600} c='dimmed'>
          {`Workspace · ${changedFileCount} ${changedFileCount === 1 ? 'file' : 'files'} · +${added} −${removed}`}
        </Text>
      </Stack>
      <Stack gap={2}>
        <Text size='xs' tt='uppercase' fw={600} c='dimmed'>
          {`Session commits · ${sessionCommits.length}`}
        </Text>
        {sessionCommits.map(commit => {
          const age = formatCommitAge(commit.timestamp);
          return (
            <Text key={commit.revision} size='xs' ff='var(--font-mono)' c='dimmed'>
              {`r${commit.revisionNumber}`}
              {commit.message !== undefined ? ` ${commit.message}` : ''}
              {age !== null ? ` · ${age}` : ''}
            </Text>
          );
        })}
      </Stack>
    </Group>
  );
}

function CardActions({
  workspace,
  dirty,
  onReview,
  onOpenTerminal,
}: {
  readonly workspace: WorkspaceCard['workspace'];
  readonly dirty: boolean;
  readonly onReview: (intent: OpenReviewIntent) => void;
  readonly onOpenTerminal: (path: string) => void;
}): ReactElement {
  return (
    <Group gap='xs' grow>
      <Button
        variant='default'
        size='xs'
        onClick={() => onReview({ workspace, workflow: 'commit' })}
      >
        Review
      </Button>
      {dirty ? (
        <Button
          size='xs'
          onClick={() => onReview({ workspace, workflow: 'commit' })}
          title='Workspace is dirty — commit before merging'
        >
          Commit
        </Button>
      ) : (
        <Button size='xs' onClick={() => onReview({ workspace, workflow: 'merge' })}>
          Merge → main
        </Button>
      )}
      <Button variant='default' size='xs' onClick={() => onOpenTerminal(workspace.path)}>
        Open terminal
      </Button>
    </Group>
  );
}

function TaskList({ tasks }: { readonly tasks: AgentTask[] }): ReactElement {
  const done = tasks.filter(task => task.status === 'done').length;
  return (
    <Stack gap={4}>
      <Text size='xs' tt='uppercase' fw={600} c='dimmed'>
        {`Tasks · ${done} of ${tasks.length}`}
      </Text>
      {tasks.map(task => (
        <Group key={task.subject} gap={7} wrap='nowrap' align='baseline'>
          <Text component='span' aria-hidden size='sm'>
            {TASK_GLYPH[task.status]}
          </Text>
          <Text size='sm' fw={task.status === 'running' ? 600 : 400}>
            {task.subject}
          </Text>
          {task.status === 'running' && task.runningElapsedMs !== undefined && (
            <Text size='xs' ff='var(--font-mono)' c='dimmed'>
              {`running ${formatElapsed(task.runningElapsedMs)}`}
            </Text>
          )}
        </Group>
      ))}
    </Stack>
  );
}

function Commentary({ card }: { readonly card: WorkspaceCard }): ReactElement {
  // Newest two commentary entries (design 2a "Recent commentary").
  const recent = [...(card.intention?.commentary ?? [])].slice(-2).reverse();
  return (
    <Stack gap={2} style={{ borderTop: '1px dashed var(--hair)', paddingTop: 8 }}>
      <Text size='xs' tt='uppercase' fw={600} c='dimmed'>
        Recent commentary
      </Text>
      {recent.map(entry => (
        <Text key={`${entry.at}-${entry.text}`} size='xs'>
          <Text component='span' ff='var(--font-mono)' c='dimmed' mr={6}>
            {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
          {entry.text}
        </Text>
      ))}
    </Stack>
  );
}
