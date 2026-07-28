import type { ReactElement } from 'react';

// Two-lane constellation geometry: a parent row above a child row. Shared
// with HistoryTimeline's ConstellationTimeline, which renders both lanes on
// these y coordinates.
export const LANE_TIMELINE_HEIGHT = 40;
export const PARENT_CY = 10;
export const CHILD_CY = 30;

interface MergeAnnotationProps {
  readonly x: number;
  // 'down' = a merge accepted into the child from the parent (arrowhead at
  // the child lane); 'up' = accepted into the parent from the child
  // (arrowhead at the parent lane).
  readonly direction: 'down' | 'up';
  readonly title: string;
  // The true source node's x on the OTHER lane, when that node is rendered:
  // the connector runs from it to `x` — vertical when the layout anchored
  // both to one x, diagonal otherwise. Undefined = the source isn't on the
  // canvas, so a vertical stub at `x` carries a label naming it instead of
  // a line implying the wrong node.
  readonly sourceX: number | undefined;
  readonly fallbackLabel: string;
  readonly testId: string;
}

// A dashed lane-to-lane merge connector with an arrowhead at the receiving
// lane — legible even when the target node also carries current/selection
// halos.
export function MergeAnnotation({
  x,
  direction,
  title,
  sourceX,
  fallbackLabel,
  testId,
}: MergeAnnotationProps): ReactElement {
  const down = direction === 'down';
  const lineY1 = down ? PARENT_CY + 3 : CHILD_CY - 3;
  const lineY2 = down ? CHILD_CY - 6 : PARENT_CY + 6;
  const apexY = down ? CHILD_CY - 4 : PARENT_CY + 4;
  const flareY = down ? CHILD_CY - 7.5 : PARENT_CY + 7.5;
  const labelY = down ? PARENT_CY + 2 : CHILD_CY - 2;
  // Align the chevron with the connector: the angle between its base
  // orientation (straight down/up) and the source→receiver direction,
  // pivoting on the apex so the tip stays at the receiving node. Zero on
  // vertical connectors and label-fallback stubs.
  const angleDeg =
    (Math.atan2(lineY2 - lineY1, x - (sourceX ?? x)) - Math.atan2(down ? 1 : -1, 0)) *
    (180 / Math.PI);
  return (
    <g data-testid={testId} aria-hidden='true'>
      <title>{title}</title>
      <line
        x1={sourceX ?? x}
        y1={lineY1}
        x2={x}
        y2={lineY2}
        stroke='var(--acc)'
        strokeOpacity={0.75}
        strokeWidth={1.4}
        strokeDasharray='3 2'
      />
      <path
        d={`M ${x - 2.4} ${flareY} L ${x} ${apexY} L ${x + 2.4} ${flareY}`}
        fill='none'
        stroke='var(--acc)'
        strokeOpacity={0.9}
        strokeWidth={1.4}
        strokeLinecap='round'
        {...(angleDeg !== 0 && { transform: `rotate(${angleDeg} ${x} ${apexY})` })}
      />
      {sourceX === undefined && (
        <text
          data-testid={`${testId}-fallback-label`}
          x={x + 4}
          y={labelY}
          fontSize={7}
          fontFamily='var(--font-mono)'
          fill='var(--ink-faint)'
        >
          {fallbackLabel}
        </text>
      )}
    </g>
  );
}
