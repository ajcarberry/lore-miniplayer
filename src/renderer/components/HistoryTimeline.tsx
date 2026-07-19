import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';
import { Box, Group, ScrollArea, Text } from '@mantine/core';
import type {
  BranchGraphParentLane,
  MergeFromParent,
  MergeToParent,
  RevisionSummary,
} from '../../shared/types';
import type { LaneLayoutAnchor } from './laneLayout';
import { EDGE_PADDING_PX, computeLaneLayout, laneWidthPx, lanePositionsPx } from './laneLayout';
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
}

// A clickable child-lane node. The selection halo (soft, translucent) and the
// current-revision ring (solid accent) are distinct and can co-exist on the
// same node. Reduced-motion is honored for free — nothing animates.
function TimelineNode({
  cx,
  cy,
  revisionNumber,
  selected,
  isCurrent,
  onSelect,
}: TimelineNodeProps): ReactElement {
  return (
    <g
      role='button'
      tabIndex={0}
      data-current={isCurrent ? 'true' : undefined}
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

// The parent lane's rendered window: from the branch point onward (newest →
// branch point), with pre-fork history elided. When the branch point isn't in
// the walked window, render the walked parent revisions as-is.
function parentWindow(parent: BranchGraphParentLane): {
  parentNodes: RevisionSummary[];
  hasElidedBefore: boolean;
  bpNodeIdx: number;
} {
  const bpIdx = parent.revisions.findIndex(revision => revision.revision === parent.branchPoint);
  const parentNodes = bpIdx >= 0 ? parent.revisions.slice(0, bpIdx + 1) : parent.revisions;
  return {
    parentNodes,
    hasElidedBefore: bpIdx >= 0 && bpIdx + 1 < parent.revisions.length,
    bpNodeIdx: parentNodes.findIndex(revision => revision.revision === parent.branchPoint),
  };
}

// Two-lane constellation: the parent branch above, the current branch below,
// with a branch-point connector from the fork down to the child's first node
// and a distinct marker on each child merge node accepted from the parent.
// The child lane keeps full selection/scrub behavior and the current-revision
// marker; the parent lane is informational in v1. Both lanes share one pixel
// canvas, laid out by computeLaneLayout so the branch point and every merge
// whose true source falls within the rendered parent window land at the
// same x on both lanes — their connectors are guaranteed vertical.
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
  const childNodes = revisions;
  const { parentNodes, hasElidedBefore, bpNodeIdx } = parentWindow(parent);

  const oldestChildHash = childNodes[childNodes.length - 1]?.revision;
  const branchAnchors: LaneLayoutAnchor[] =
    bpNodeIdx >= 0 && oldestChildHash !== undefined
      ? [{ child: oldestChildHash, parent: parent.branchPoint }]
      : [];
  const parentNodeHashes = new Set(parentNodes.map(revision => revision.revision));
  const mergeAnchors: LaneLayoutAnchor[] = mergesFromParent
    .filter(pair => parentNodeHashes.has(pair.parentSource))
    .map(pair => ({ child: pair.child, parent: pair.parentSource }));
  const childNodeHashes = new Set(childNodes.map(revision => revision.revision));
  const mergeUpAnchors: LaneLayoutAnchor[] = mergesToParent
    .filter(pair => parentNodeHashes.has(pair.parent) && childNodeHashes.has(pair.childSource))
    .map(pair => ({ child: pair.childSource, parent: pair.parent }));

  const layout = computeLaneLayout(
    childNodes.map(revision => revision.revision),
    parentNodes.map(revision => revision.revision),
    [...branchAnchors, ...mergeAnchors, ...mergeUpAnchors]
  );
  const childX = layout.childPositions;
  const parentX = layout.parentPositions;
  const width = layout.width;
  const oldestChildX = childX[childX.length - 1] ?? EDGE_PADDING_PX;
  const branchPointX = bpNodeIdx >= 0 ? (parentX[bpNodeIdx] ?? EDGE_PADDING_PX) : EDGE_PADDING_PX;

  const parentIndexByHash = new Map(parentNodes.map((revision, j) => [revision.revision, j]));
  const mergeSourceByChild = new Map(mergesFromParent.map(pair => [pair.child, pair.parentSource]));
  const childIndexByHash = new Map(childNodes.map((revision, i) => [revision.revision, i]));
  const mergeUpSourceByParent = new Map(
    mergesToParent.map(pair => [pair.parent, pair.childSource])
  );
  const selectedX =
    selectedIndex >= 0 && selectedIndex < childNodes.length ? childX[selectedIndex] : undefined;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  useScrollToNewest(viewportRef, childNodes.map(revision => revision.revision).join('|'));

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
          {/* Branch-point connector: parent fork node → child's first node */}
          {childNodes.length > 0 && (
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
          {/* Elided pre-fork history marker on the branch-point node */}
          {hasElidedBefore && (
            <circle
              cx={branchPointX}
              cy={PARENT_CY}
              r={4}
              fill='none'
              stroke='var(--ink-faint)'
              strokeDasharray='1 1'
            />
          )}
          {/* Parent lane nodes (informational) */}
          {parentNodes.map((revision, j) => (
            <g key={revision.revision} data-revision={revision.revision} aria-hidden='true'>
              <circle
                cx={parentX[j]}
                cy={PARENT_CY}
                r={revision.revision === parent.branchPoint ? 2.5 : 1.8}
                fill='var(--ink-faint)'
              />
            </g>
          ))}
          {/* Merge-from-parent annotations on the child lane. When the true
              source sits in the rendered parent window, computeLaneLayout
              has already anchored childX[i] to that node's x, so this drop
              points at the real source. Otherwise (source elided/out of
              window) the drop can't be anchored — a small label names the
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
                anchored={sourceIdx !== undefined && childX[i] === parentX[sourceIdx]}
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
              parent lane. When both ends are rendered, computeLaneLayout has
              anchored them to one x — the connector is vertical and points
              at the real nodes. Otherwise a small label names the child
              source so the annotation doesn't imply the wrong node. */}
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
                anchored={sourceIdx !== undefined && parentX[j] === childX[sourceIdx]}
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
