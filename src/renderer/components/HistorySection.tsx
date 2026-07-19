import type { ReactElement } from 'react';
import { Box, Button, Group, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import type {
  BranchGraphParentLane,
  MergeFromParent,
  MergeToParent,
  RevisionSummary,
} from '../../shared/types';
import classes from './HistorySection.module.css';
import { ConstellationTimeline, HistoryTimeline } from './HistoryTimeline';

export interface HistorySectionProps {
  readonly branchName: string;
  readonly revisions: RevisionSummary[];
  // The working copy's current revision hash (empty when unknown).
  readonly current: string;
  // The parent branch lane, when the branch has a resolvable parent.
  readonly parent?: BranchGraphParentLane;
  // Child merge revisions paired with their true parent-lineage source.
  readonly mergesFromParent: ReadonlyArray<MergeFromParent>;
  // Parent merge revisions paired with their true child-lineage source.
  readonly mergesToParent: ReadonlyArray<MergeToParent>;
  readonly isLoading: boolean;
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
  // Opens the sync flow prefilled with the given revision hash.
  readonly onSyncToSelected: (revision: string) => void;
}

// First 8 hex characters of the revision hash — the compact identifier used
// as a fallback when a revision has no commit message (see RevisionSummary's
// doc comment).
function shortHash(revision: string): string {
  return revision.length > 8 ? revision.slice(0, 8) : revision;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

// Tiny local "2h ago"-style relative-time formatter — no new deps. Negative
// deltas (clock skew) clamp to "just now" rather than showing a future time.
function relativeTime(timestampMs: number): string {
  const deltaMs = Math.max(0, Date.now() - timestampMs);
  if (deltaMs < MINUTE_MS) {
    return 'just now';
  }
  if (deltaMs < HOUR_MS) {
    return `${Math.floor(deltaMs / MINUTE_MS)}m ago`;
  }
  if (deltaMs < DAY_MS) {
    return `${Math.floor(deltaMs / HOUR_MS)}h ago`;
  }
  if (deltaMs < MONTH_MS) {
    return `${Math.floor(deltaMs / DAY_MS)}d ago`;
  }
  if (deltaMs < YEAR_MS) {
    return `${Math.floor(deltaMs / MONTH_MS)}mo ago`;
  }
  return `${Math.floor(deltaMs / YEAR_MS)}y ago`;
}

// The ledger row's secondary text: revision number, plus relative time when
// a timestamp was harvested during enrichment.
function rowSecondary(revision: RevisionSummary): string {
  return revision.timestamp === undefined
    ? `r${revision.revisionNumber}`
    : `r${revision.revisionNumber} · ${relativeTime(revision.timestamp)}`;
}

// A revision's display message: the SDK supplies an empty string for
// sync-generated merge revisions, which must fall back like a missing one.
function displayMessage(revision: RevisionSummary): string | undefined {
  const trimmed = revision.message?.trim();
  return trimmed === '' ? undefined : trimmed;
}

// The header caption's text: the selected revision's message when present,
// else its short hash and number.
function headerCaption(revision: RevisionSummary): string {
  return (
    displayMessage(revision) ?? `${shortHash(revision.revision)} · r${revision.revisionNumber}`
  );
}

interface HistoryRowProps {
  readonly revision: RevisionSummary;
  readonly index: number;
  readonly selected: boolean;
  readonly isCurrent: boolean;
  readonly onSelect: (index: number) => void;
}

// Ledger row: rail dot, mono primary text (message when the SDK supplies
// one, else the short hash), and the revision number. Selected rows pick up
// the soft accent wash; the current revision gets a filled accent dot with a
// ring and a 'current' badge — distinct from, and combinable with, selection.
function HistoryRow({
  revision,
  index,
  selected,
  isCurrent,
  onSelect,
}: HistoryRowProps): ReactElement {
  const primary = displayMessage(revision) ?? shortHash(revision.revision);
  return (
    <Box
      p='4px 8px'
      data-selected={selected ? 'true' : undefined}
      data-current={isCurrent ? 'true' : undefined}
      style={{
        cursor: 'pointer',
        borderRadius: '4px',
        background: selected ? 'var(--acc-soft)' : undefined,
      }}
      onClick={() => onSelect(index)}
    >
      <Group gap={6} wrap='nowrap'>
        <span
          style={{
            width: isCurrent ? 8 : 6,
            height: isCurrent ? 8 : 6,
            borderRadius: '50%',
            backgroundColor: isCurrent || selected ? 'var(--acc)' : 'var(--hair)',
            boxShadow: isCurrent ? '0 0 0 2px var(--acc-soft)' : undefined,
            flexShrink: 0,
          }}
        />
        <Text size='xs' ff='var(--font-mono)' fw={600} truncate style={{ minWidth: 0 }}>
          {primary}
        </Text>
        {isCurrent && (
          <Text
            size='9px'
            ff='var(--font-mono)'
            fw={700}
            tt='uppercase'
            style={{ color: 'var(--acc)', flexShrink: 0 }}
          >
            current
          </Text>
        )}
        <Text
          size='xs'
          c='dimmed'
          ff='var(--font-mono)'
          style={{ flexShrink: 0, marginLeft: 'auto' }}
        >
          {rowSecondary(revision)}
        </Text>
      </Group>
    </Box>
  );
}

// The card's history section: an uppercase header with the selected
// revision's caption (or a 'Sync to r<n>' action when the selection differs
// from the current revision), a slim clickable timeline (single-lane, or a
// two-lane parent constellation when a parent branch resolves), and a
// scrollable ledger of every revision (newest first). Selection is view-state
// only — which revision is inspected — it does not sync the repo; syncing is
// an explicit action.
export function HistorySection({
  branchName,
  revisions,
  current,
  parent,
  mergesFromParent,
  mergesToParent,
  isLoading,
  selectedIndex,
  onSelect,
  onSyncToSelected,
}: HistorySectionProps): ReactElement {
  const selected = revisions[selectedIndex];
  const canSyncToSelected =
    selected !== undefined && current !== '' && selected.revision !== current;

  return (
    <Box>
      <Group justify='space-between' wrap='nowrap' p='4px 0'>
        <Text size='xs' fw={700} tt='uppercase' c='dimmed'>
          History
        </Text>
        {canSyncToSelected ? (
          <Button
            size='compact-xs'
            variant='light'
            onClick={() => onSyncToSelected(selected.revision)}
            styles={{
              root: {
                backgroundColor: 'var(--acc-soft)',
                color: 'var(--acc)',
                fontFamily: 'var(--font-mono)',
              },
            }}
          >
            {`Sync to r${selected.revisionNumber}`}
          </Button>
        ) : (
          selected && (
            <Text size='xs' c='dimmed' ff='var(--font-mono)' truncate style={{ minWidth: 0 }}>
              {headerCaption(selected)}
            </Text>
          )
        )}
      </Group>
      {isLoading ? (
        <Box p='8px' style={{ textAlign: 'center' }}>
          <Loader size='xs' aria-label='Loading history' />
        </Box>
      ) : revisions.length === 0 ? (
        <Text size='xs' c='dimmed'>
          No history yet
        </Text>
      ) : (
        <Stack gap={6}>
          {parent ? (
            <ConstellationTimeline
              branchName={branchName}
              revisions={revisions}
              current={current}
              parent={parent}
              mergesFromParent={mergesFromParent}
              mergesToParent={mergesToParent}
              selectedIndex={selectedIndex}
              onSelect={onSelect}
            />
          ) : (
            <HistoryTimeline
              revisions={revisions}
              current={current}
              selectedIndex={selectedIndex}
              onSelect={onSelect}
            />
          )}
          <ScrollArea.Autosize
            mah={150}
            offsetScrollbars
            scrollbars='y'
            classNames={{ viewport: classes.ledgerViewport }}
          >
            <Stack gap={0}>
              {revisions.map((revision, index) => (
                <HistoryRow
                  key={revision.revision}
                  revision={revision}
                  index={index}
                  selected={index === selectedIndex}
                  isCurrent={current !== '' && revision.revision === current}
                  onSelect={onSelect}
                />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      )}
    </Box>
  );
}
