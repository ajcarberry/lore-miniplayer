import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { Box, Group, ScrollArea, Text } from '@mantine/core';
import type {
  BranchGraphParentLane,
  MergeFromParent,
  MergeToParent,
  RevisionSummary,
} from '../../shared/types';
import {
  EDGE_PADDING_PX,
  computeConstellationModel,
  laneWidthPx,
  lanePositionsPx,
} from './laneLayout';
import { CHILD_CY, LANE_TIMELINE_HEIGHT, MergeAnnotation, PARENT_CY } from './MergeAnnotation';

const TIMELINE_HEIGHT = 28;
const NODE_HIT_RADIUS = 6;

// Scrolls the given ScrollArea viewport all the way to its right (newest)
// edge whenever `identity` changes — including on mount — without
// re-triggering on unrelated re-renders (e.g. selection changes).
function useScrollToNewest(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  identity: string
): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = viewport.scrollWidth;
    }
  }, [viewportRef, identity]);
}

interface TimelineNodeProps {
  readonly cx: number;
  readonly cy: number;
  readonly revisionNumber: number;
  readonly selected: boolean;
  readonly isCurrent: boolean;
  readonly onSelect: () => void;
  // Set on parent-lane nodes so tests and tools can address them by hash;
  // child-lane nodes are addressed by their aria-label.
  readonly revision?: string;
}

// A clickable lane node. The selection halo (soft, translucent) and the
// current-revision ring (solid accent) are distinct and can co-exist on the
// same node. Reduced-motion is honored for free — nothing animates.
function TimelineNode({
  cx,
  cy,
  revisionNumber,
  selected,
  isCurrent,
  onSelect,
  revision,
}: TimelineNodeProps): ReactElement {
  return (
    <g
      role='button'
      tabIndex={0}
      data-current={isCurrent ? 'true' : undefined}
      {...(revision !== undefined && { 'data-revision': revision })}
      aria-label={`Select revision r${revisionNumber}`}
      style={{ cursor: 'pointer' }}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <circle cx={cx} cy={cy} r={NODE_HIT_RADIUS} fill='transparent' />
      {selected && (
        <circle cx={cx} cy={cy} r={5.5} fill='none' stroke='var(--acc)' strokeOpacity={0.35} />
      )}
      {isCurrent && (
        <circle cx={cx} cy={cy} r={4.5} fill='none' stroke='var(--acc)' strokeWidth={1.2} />
      )}
      <circle
        cx={cx}
        cy={cy}
        r={selected || isCurrent ? 3.5 : 2}
        fill={selected || isCurrent ? 'var(--acc)' : 'var(--ink-faint)'}
      />
    </g>
  );
}

interface HistoryTimelineProps {
  readonly revisions: RevisionSummary[];
  readonly current: string;
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
}

// Slim single-lane SVG timeline: evenly spaced nodes, oldest at the left /
// newest at the right (revisions arrive newest-first, so display position
// mirrors array index). The accent-colored "played" segment runs from the
// oldest node up to the selected one; the selection gets a soft halo, and the
// current revision a solid ring. Rendered when the branch has no parent lane.
export function HistoryTimeline({
  revisions,
  current,
  selectedIndex,
  onSelect,
}: HistoryTimelineProps): ReactElement {
  const nodes = revisions;
  const count = nodes.length;
  const width = laneWidthPx(count);
  const cy = TIMELINE_HEIGHT / 2;
  const positions = lanePositionsPx(count);
  const selectedPos =
    selectedIndex >= 0 && selectedIndex < count ? positions[selectedIndex] : undefined;
  const oldestPos = positions[count - 1] ?? EDGE_PADDING_PX;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  useScrollToNewest(viewportRef, nodes.map(revision => revision.revision).join('|'));

  return (
    <ScrollArea scrollbars='x' offsetScrollbars viewportRef={viewportRef}>
      <svg
        viewBox={`0 0 ${width} ${TIMELINE_HEIGHT}`}
        width={width}
        height={TIMELINE_HEIGHT}
        role='img'
        aria-label='Revision timeline'
      >
        <polyline
          points={positions.map(x => `${x},${cy}`).join(' ')}
          fill='none'
          stroke='var(--hair)'
          strokeWidth={1}
        />
        {selectedPos !== undefined && (
          <line
            x1={oldestPos}
            y1={cy}
            x2={selectedPos}
            y2={cy}
            stroke='var(--acc)'
            strokeWidth={1.5}
          />
        )}
        {nodes.map((revision, i) => (
          <TimelineNode
            key={revision.revision}
            cx={positions[i] ?? 0}
            cy={cy}
            revisionNumber={revision.revisionNumber}
            selected={i === selectedIndex}
            isCurrent={current !== '' && revision.revision === current}
            onSelect={() => onSelect(i)}
          />
        ))}
      </svg>
    </ScrollArea>
  );
}

interface ConstellationTimelineProps {
  readonly branchName: string;
  readonly revisions: RevisionSummary[];
  readonly current: string;
  readonly parent: BranchGraphParentLane;
  readonly mergesFromParent: ReadonlyArray<MergeFromParent>;
  readonly mergesToParent: ReadonlyArray<MergeToParent>;
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
}

// Two-lane constellation drawn by OWNERSHIP: every revision renders on the
// lane of the branch it was committed on. The checkout's own commits — the
// newest-first prefix of its lineage strictly above the branch point — form
// the child lane; the shared pre-fork trunk belongs to the parent lineage and
// rides the parent lane, which renders its full walked window (no fork-side
// elision). Trunk rows stay selectable ledger rows: their nodes render on the
// parent lane with full selection/current markers, mapping clicks back to
// ledger indices. Both lanes share one pixel canvas, laid out by
// computeLaneLayout so the fork (oldest own commit under the branch point)
// and every merge pair it could anchor land at the same x on both lanes —
// those connectors render vertical; a pair the layout could NOT anchor still
// connects its two real nodes, as a diagonal.
interface ParentLaneNodeProps {
  readonly revision: RevisionSummary;
  readonly cx: number;
  readonly isBranchPoint: boolean;
  // The revision's ledger row, when the checkout's lineage holds it.
  readonly ledgerIdx: number | undefined;
  readonly selectedIndex: number;
  readonly current: string;
  readonly onSelect: (index: number) => void;
}

// A parent-lane node. Trunk revisions the checkout's ledger holds stay fully
// selectable — the row's node simply lives on its owning lane, and clicks
// route back to the ledger index; parent-only revisions are informational.
function ParentLaneNode({
  revision,
  cx,
  isBranchPoint,
  ledgerIdx,
  selectedIndex,
  current,
  onSelect,
}: ParentLaneNodeProps): ReactElement {
  if (ledgerIdx !== undefined) {
    return (
      <TimelineNode
        cx={cx}
        cy={PARENT_CY}
        revisionNumber={revision.revisionNumber}
        selected={ledgerIdx === selectedIndex}
        isCurrent={current !== '' && revision.revision === current}
        onSelect={() => onSelect(ledgerIdx)}
        revision={revision.revision}
      />
    );
  }
  return (
    <g data-revision={revision.revision} aria-hidden='true'>
      <circle cx={cx} cy={PARENT_CY} r={isBranchPoint ? 2.5 : 1.8} fill='var(--ink-faint)' />
    </g>
  );
}

export function ConstellationTimeline({
  branchName,
  revisions,
  current,
  parent,
  mergesFromParent,
  mergesToParent,
  selectedIndex,
  onSelect,
}: ConstellationTimelineProps): ReactElement {
  const {
    childNodes,
    parentNodes,
    childX,
    parentX,
    width,
    oldestChildX,
    branchPointX,
    showForkConnector,
    hasElidedBefore,
    ledgerIndexByHash,
    parentIndexByHash,
    childIndexByHash,
    mergeSourceByChild,
    mergeUpSourceByParent,
  } = computeConstellationModel(revisions, parent, mergesFromParent, mergesToParent);

  // The played segment runs on the child lane only while the selection is an
  // own commit (child lane indices are a ledger prefix, so indices agree).
  const selectedX =
    selectedIndex >= 0 && selectedIndex < childNodes.length ? childX[selectedIndex] : undefined;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  useScrollToNewest(
    viewportRef,
    `${childNodes.map(revision => revision.revision).join('|')}|${parentNodes[0]?.revision ?? ''}`
  );

  return (
    <Box>
      <Group gap={6} wrap='nowrap' pl={2}>
        <Text size='9px' ff='var(--font-mono)' c='dimmed' truncate>
          {parent.name}
        </Text>
        <Text size='9px' c='dimmed'>
          ↑
        </Text>
        <Text size='9px' ff='var(--font-mono)' fw={600} truncate style={{ color: 'var(--acc)' }}>
          {branchName}
        </Text>
      </Group>
      <ScrollArea scrollbars='x' offsetScrollbars viewportRef={viewportRef}>
        <svg
          viewBox={`0 0 ${width} ${LANE_TIMELINE_HEIGHT}`}
          width={width}
          height={LANE_TIMELINE_HEIGHT}
          role='img'
          aria-label={`Branch graph: ${branchName} over ${parent.name}`}
        >
          {/* Parent lane track */}
          <polyline
            points={parentX.map(x => `${x},${PARENT_CY}`).join(' ')}
            fill='none'
            stroke='var(--hair)'
            strokeWidth={1}
          />
          {/* Child lane track */}
          <polyline
            points={childX.map(x => `${x},${CHILD_CY}`).join(' ')}
            fill='none'
            stroke='var(--hair)'
            strokeWidth={1}
          />
          {/* Played segment on the child lane, oldest → selected */}
          {selectedX !== undefined && (
            <line
              x1={oldestChildX}
              y1={CHILD_CY}
              x2={selectedX}
              y2={CHILD_CY}
              stroke='var(--acc)'
              strokeWidth={1.5}
            />
          )}
          {/* Branch-point connector: parent fork node → child's oldest own commit */}
          {showForkConnector && (
            <line
              data-testid='branch-connector'
              x1={branchPointX}
              y1={PARENT_CY}
              x2={oldestChildX}
              y2={CHILD_CY}
              stroke='var(--acc)'
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray='2 2'
            />
          )}
          {/* Elided history marker on the parent lane's oldest node, when the
              ledger's trunk runs deeper than the walked parent window */}
          {hasElidedBefore && (
            <circle
              cx={parentX[parentX.length - 1] ?? EDGE_PADDING_PX}
              cy={PARENT_CY}
              r={4}
              fill='none'
              stroke='var(--ink-faint)'
              strokeDasharray='1 1'
            />
          )}
          {parentNodes.map((revision, j) => (
            <ParentLaneNode
              key={revision.revision}
              revision={revision}
              cx={parentX[j] ?? 0}
              isBranchPoint={revision.revision === parent.branchPoint}
              ledgerIdx={ledgerIndexByHash.get(revision.revision)}
              selectedIndex={selectedIndex}
              current={current}
              onSelect={onSelect}
            />
          ))}
          {/* Merge-from-parent annotations on the child lane. When the true
              source sits in the rendered parent window, the connector runs
              from that node — vertical when computeLaneLayout anchored the
              pair, diagonal otherwise. When the source is elided/out of
              window there is no node to point at — a small label names the
              source so the annotation doesn't imply the wrong node. */}
          {childNodes.map((revision, i) => {
            const parentSource = mergeSourceByChild.get(revision.revision);
            if (parentSource === undefined) {
              return null;
            }
            const sourceIdx = parentIndexByHash.get(parentSource);
            const sourceRevisionNumber = parent.revisions.find(
              r => r.revision === parentSource
            )?.revisionNumber;
            return (
              <MergeAnnotation
                key={`merge-${revision.revision}`}
                x={childX[i] ?? 0}
                direction='down'
                title={`Merged from ${parent.name}`}
                sourceX={sourceIdx !== undefined ? parentX[sourceIdx] : undefined}
                fallbackLabel={
                  sourceRevisionNumber !== undefined
                    ? `from r${sourceRevisionNumber}`
                    : 'from parent'
                }
                testId='merge-marker'
              />
            );
          })}
          {/* Merge-to-parent annotations: a rising connector from the child
              source node up to the parent merge node, arrowhead at the
              parent lane. When both ends are rendered the connector runs
              between the real nodes — vertical when computeLaneLayout
              anchored them to one x, diagonal when the child source's x is
              already claimed (every workspace landing: the child merge
              commit anchors under ITS source first). When the child source
              isn't rendered a small label names it instead. */}
          {parentNodes.map((revision, j) => {
            const childSource = mergeUpSourceByParent.get(revision.revision);
            if (childSource === undefined) {
              return null;
            }
            const sourceIdx = childIndexByHash.get(childSource);
            const sourceRevisionNumber = childNodes.find(
              r => r.revision === childSource
            )?.revisionNumber;
            return (
              <MergeAnnotation
                key={`merge-up-${revision.revision}`}
                x={parentX[j] ?? 0}
                direction='up'
                title={`Merged to ${parent.name}`}
                sourceX={sourceIdx !== undefined ? childX[sourceIdx] : undefined}
                fallbackLabel={
                  sourceRevisionNumber !== undefined
                    ? `from r${sourceRevisionNumber}`
                    : `from ${branchName}`
                }
                testId='merge-up-marker'
              />
            );
          })}
          {/* Child lane nodes (selectable) */}
          {childNodes.map((revision, i) => (
            <TimelineNode
              key={revision.revision}
              cx={childX[i] ?? 0}
              cy={CHILD_CY}
              revisionNumber={revision.revisionNumber}
              selected={i === selectedIndex}
              isCurrent={current !== '' && revision.revision === current}
              onSelect={() => onSelect(i)}
            />
          ))}
        </svg>
      </ScrollArea>
    </Box>
  );
}
