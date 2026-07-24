import type { ReactElement } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import type { AgentIntention, AgentTask } from '../../../shared/types';
import { TASK_GLYPH } from '../../utils/taskGlyph';
import { SectionLabel } from '../SectionLabel';
import { useIntention } from './useIntention';

export interface IntentionPanelProps {
  readonly repositoryId: string;
  readonly workspacePath: string;
}

const TASK_GLYPH_COLOR: Record<AgentTask['status'], string> = {
  done: 'teal',
  running: 'var(--acc-deep, #7a5b1e)',
  pending: 'dimmed',
};

const LABEL_SPACING = '0.08em';

function TaskRow({ task }: { readonly task: AgentTask }): ReactElement {
  return (
    <Group gap={6} wrap='nowrap' align='flex-start'>
      <Text span size='sm' c={TASK_GLYPH_COLOR[task.status]} style={{ width: 14 }}>
        {TASK_GLYPH[task.status]}
      </Text>
      <Text size='sm' style={{ flex: 1 }}>
        {task.subject}
      </Text>
    </Group>
  );
}

// The intention body (design 2b): what the agent was asked, its task list,
// and its own prose account — only the sections the intention actually
// carries (transcript enrichment is best-effort; a partial intention never
// renders an empty section).
function IntentionBody({ intention }: { readonly intention: AgentIntention }): ReactElement {
  const doneCount = intention.tasks.filter(task => task.status === 'done').length;

  return (
    <Stack gap={18}>
      {intention.prompt && (
        <Stack gap={4} data-testid='intention-asked'>
          <SectionLabel lts={LABEL_SPACING}>Asked</SectionLabel>
          <Text
            size='sm'
            fs='italic'
            style={{
              borderLeft: '2px solid var(--hairline, rgba(43,36,22,.15))',
              paddingLeft: 10,
            }}
          >
            {intention.prompt}
          </Text>
        </Stack>
      )}

      {intention.tasks.length > 0 && (
        <Stack gap={6} data-testid='intention-tasks'>
          <SectionLabel lts={LABEL_SPACING}>
            {`Tasks (${doneCount} of ${intention.tasks.length})`}
          </SectionLabel>
          <Stack gap={5}>
            {intention.tasks.map((task, index) => (
              // Tasks carry no stable id (P8's AgentIntention.tasks is position-ordered).
              // eslint-disable-next-line react/no-array-index-key
              <TaskRow key={index} task={task} />
            ))}
          </Stack>
        </Stack>
      )}

      {intention.summary && (
        <Stack gap={4} data-testid='intention-summary'>
          <SectionLabel lts={LABEL_SPACING}>{"Agent's account"}</SectionLabel>
          <Text size='sm'>{intention.summary}</Text>
        </Stack>
      )}
    </Stack>
  );
}

// "from transcript · session <id> · $<cost>" (design 2b); cost is omitted
// when the intention carries no costUsd (P8 doesn't always produce one —
// never fabricated). No sessionId means nothing to attribute the intention
// to, so the footer renders nothing at all.
function sessionFooter(intention: AgentIntention): ReactElement | undefined {
  if (!intention.sessionId) {
    return undefined;
  }
  const cost = intention.costUsd !== undefined ? ` · $${intention.costUsd.toFixed(2)}` : '';
  return (
    <Text size='xs' c='dimmed' ff='var(--font-mono)'>
      {`from transcript · session ${intention.sessionId}${cost}`}
    </Text>
  );
}

// The review window's right pane (design 2b, P12): the intention column.
// Sources the workspace's AgentIntention from the workspace model snapshot
// (P9/P10 — the richest existing IPC surface for it, see useIntention).
// Degrades to a diff-only placeholder when no intention was recorded, and to
// only the sections a partial intention actually carries otherwise — never a
// raw thinking stream.
export function IntentionPanel(props: IntentionPanelProps): ReactElement {
  const intention = useIntention(props.repositoryId, props.workspacePath);
  const hasContent =
    intention !== null &&
    (Boolean(intention.prompt) || intention.tasks.length > 0 || Boolean(intention.summary));

  return (
    <Stack
      gap={14}
      p='md'
      h='100%'
      style={{ borderLeft: '1px solid var(--hairline, rgba(43,36,22,.1))' }}
    >
      <Box style={{ flex: 1 }} data-testid='review-intention-region'>
        {hasContent && intention ? (
          <IntentionBody intention={intention} />
        ) : (
          <Text size='sm' c='dimmed' data-testid='intention-placeholder'>
            No agent session recorded.
          </Text>
        )}
      </Box>
      <Box data-testid='review-session-footer'>
        {intention && hasContent ? sessionFooter(intention) : undefined}
      </Box>
    </Stack>
  );
}
