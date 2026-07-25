import type { ReactElement } from 'react';
import { Badge, Box, Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { AgentCommentaryEntry, AgentTask, WorkspaceCard } from '../../../shared/types';
import { pluralize } from '../../utils/pluralize';
import { TASK_GLYPH } from '../../utils/taskGlyph';
import { SectionLabel } from '../SectionLabel';
import type { OpenReviewIntent } from './reviewIntent';
import { deriveWorkspaceFlags, formatCommitAge, formatElapsed } from './format';
import { WorkspaceIdentity, WorkspaceRemovalActions } from './WorkspaceRowChrome';

export interface MissionCardProps {
  readonly card: WorkspaceCard;
  readonly onOpenTerminal: (path: string) => void;
  readonly onTeardown: (card: WorkspaceCard) => void;
  readonly onReview: (intent: OpenReviewIntent) => void;
  // Untrack-only removal (design amendment) — the non-destructive
  // counterpart to onTeardown. Disabled for the active card, same as ✕.
  readonly onForget: (card: WorkspaceCard) => void;
}

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

        {showCommentary && <Commentary commentary={intention.commentary} />}

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
  onTeardown,
  onForget,
}: {
  readonly workspace: WorkspaceCard['workspace'];
  readonly inProgress: boolean;
  readonly isActive: boolean;
  readonly dirty: boolean;
  readonly onTeardown: () => void;
  readonly onForget: () => void;
}): ReactElement {
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
      <WorkspaceIdentity workspace={workspace} isActive={isActive} />
      {dirty ? (
        <Badge color='yellow' variant='light' size='sm'>
          uncommitted
        </Badge>
      ) : (
        <Text size='xs' c='dimmed' ff='var(--font-mono)'>
          clean
        </Text>
      )}
      <WorkspaceRemovalActions
        workspace={workspace}
        isActive={isActive}
        onForget={onForget}
        onTeardown={onTeardown}
      />
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
        <SectionLabel>
          {`Workspace · ${changedFileCount} ${pluralize(changedFileCount, 'file')} · +${added} −${removed}`}
        </SectionLabel>
      </Stack>
      <Stack gap={2}>
        <SectionLabel>{`Session commits · ${sessionCommits.length}`}</SectionLabel>
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
      <SectionLabel>{`Tasks · ${done} of ${tasks.length}`}</SectionLabel>
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

function Commentary({
  commentary,
}: {
  readonly commentary: readonly AgentCommentaryEntry[];
}): ReactElement {
  // Newest two commentary entries (design 2a "Recent commentary").
  const recent = [...commentary].slice(-2).reverse();
  return (
    <Stack gap={2} style={{ borderTop: '1px dashed var(--hair)', paddingTop: 8 }}>
      <SectionLabel>Recent commentary</SectionLabel>
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
