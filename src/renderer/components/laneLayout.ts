// Pure pixel-layout math for the timeline SVGs — no rendering, so it
// unit-tests directly. Fixed geometry: nodes are always NODE_SPACING_PX
// apart, and the canvas always has at least EDGE_PADDING_PX clearance at
// each end — comfortably past the largest halo (the selection ring's
// radius, 5.5) so nothing ever clips.
export const NODE_SPACING_PX = 26;
export const EDGE_PADDING_PX = 14;

// Real-pixel canvas width for a single lane with `count` nodes at the fixed
// spacing/padding above (width attr == viewBox width — no stretching).
export function laneWidthPx(count: number): number {
  return count > 1 ? EDGE_PADDING_PX * 2 + (count - 1) * NODE_SPACING_PX : EDGE_PADDING_PX * 2;
}

// Evenly-spaced pixel x positions for a single newest-first lane, oldest at
// the left edge padding, newest at the right edge padding.
export function lanePositionsPx(count: number): number[] {
  return Array.from(
    { length: count },
    (_v, i) => EDGE_PADDING_PX + (count - 1 - i) * NODE_SPACING_PX
  );
}

// An x-alignment constraint between the two lanes of a constellation: the
// child hash and the parent hash that must land at the same pixel x.
export interface LaneLayoutAnchor {
  readonly child: string;
  readonly parent: string;
}

export interface LaneLayout {
  readonly childPositions: number[];
  readonly parentPositions: number[];
  readonly width: number;
}

interface AnchorPoint {
  readonly childIdx: number;
  readonly parentIdx: number;
  readonly x: number;
}

// Resolves anchors (child/parent hashes) to index pairs in the given
// oldest-to-newest lanes, keeping only those that are strictly increasing in
// both lanes (a data anomaly otherwise breaks monotonicity — dropped rather
// than honored), then assigns each a shared pixel x: the first anchor sits
// far enough right to fit whichever lane has more nodes before it; each
// later anchor sits one segment further out, where the segment width is set
// by the denser (more in-between nodes) lane at base spacing.
function resolveAnchorPoints(
  childOldToNew: readonly string[],
  parentOldToNew: readonly string[],
  anchors: readonly LaneLayoutAnchor[]
): AnchorPoint[] {
  const candidates = anchors
    .map(anchor => ({
      childIdx: childOldToNew.indexOf(anchor.child),
      parentIdx: parentOldToNew.indexOf(anchor.parent),
    }))
    .filter(a => a.childIdx !== -1 && a.parentIdx !== -1)
    .sort((a, b) => a.childIdx - b.childIdx);

  const kept: { childIdx: number; parentIdx: number }[] = [];
  for (const candidate of candidates) {
    const prev = kept[kept.length - 1];
    if (!prev || (candidate.childIdx > prev.childIdx && candidate.parentIdx > prev.parentIdx)) {
      kept.push(candidate);
    }
  }

  const first = kept[0];
  if (!first) {
    return [];
  }

  const points: AnchorPoint[] = [
    { ...first, x: EDGE_PADDING_PX + Math.max(first.childIdx, first.parentIdx) * NODE_SPACING_PX },
  ];
  for (let k = 1; k < kept.length; k++) {
    const prevAnchor = kept[k - 1];
    const curr = kept[k];
    const prevPoint = points[k - 1];
    if (!prevAnchor || !curr || !prevPoint) {
      continue;
    }
    const c = curr.childIdx - prevAnchor.childIdx - 1;
    const p = curr.parentIdx - prevAnchor.parentIdx - 1;
    const x = prevPoint.x + (Math.max(c, p) + 1) * NODE_SPACING_PX;
    points.push({ ...curr, x });
  }
  return points;
}

// Evenly distributes the lane's own nodes strictly between two known,
// shared-x anchor positions — since the segment width already accounts for
// whichever lane is denser, the gap here is never below NODE_SPACING_PX.
function fillBetween(
  positions: number[],
  startIdx: number,
  startX: number,
  endIdx: number,
  endX: number
): void {
  const n = endIdx - startIdx - 1;
  const gap = (endX - startX) / (n + 1);
  for (let i = 1; i <= n; i++) {
    positions[startIdx + i] = startX + i * gap;
  }
}

// A lane laid out with no anchors at all: base spacing throughout, oldest
// at the left padding.
function fillIndependent(length: number): number[] {
  return Array.from({ length }, (_v, i) => EDGE_PADDING_PX + i * NODE_SPACING_PX);
}

// Lays out two newest-first lanes on one shared pixel canvas so each anchor
// pair (the branch point, and any merge whose true source is within the
// rendered parent window — see ConstellationTimeline) sits at the same x on
// both lanes. Between anchors, the denser lane keeps base spacing; the
// sparser one spreads its in-between nodes evenly across the same span, so
// spacing only ever expands past the base, never compresses. Nodes before
// the first anchor / after the last continue at base spacing independently
// per lane. Positions are indexed like the input arrays (newest-first).
export function computeLaneLayout(
  childHashes: readonly string[],
  parentHashes: readonly string[],
  anchors: readonly LaneLayoutAnchor[]
): LaneLayout {
  const childOldToNew = [...childHashes].reverse();
  const parentOldToNew = [...parentHashes].reverse();
  const points = resolveAnchorPoints(childOldToNew, parentOldToNew, anchors);

  let childPos: number[];
  let parentPos: number[];

  const first = points[0];
  if (!first) {
    childPos = fillIndependent(childOldToNew.length);
    parentPos = fillIndependent(parentOldToNew.length);
  } else {
    childPos = new Array<number>(childOldToNew.length).fill(0);
    parentPos = new Array<number>(parentOldToNew.length).fill(0);

    for (let i = 0; i < first.childIdx; i++) {
      childPos[i] = first.x - (first.childIdx - i) * NODE_SPACING_PX;
    }
    for (let j = 0; j < first.parentIdx; j++) {
      parentPos[j] = first.x - (first.parentIdx - j) * NODE_SPACING_PX;
    }

    for (let k = 0; k < points.length; k++) {
      const point = points[k];
      if (!point) {
        continue;
      }
      childPos[point.childIdx] = point.x;
      parentPos[point.parentIdx] = point.x;
      const next = points[k + 1];
      if (next) {
        fillBetween(childPos, point.childIdx, point.x, next.childIdx, next.x);
        fillBetween(parentPos, point.parentIdx, point.x, next.parentIdx, next.x);
      }
    }

    const last = points[points.length - 1] ?? first;
    for (let i = last.childIdx + 1; i < childOldToNew.length; i++) {
      childPos[i] = last.x + (i - last.childIdx) * NODE_SPACING_PX;
    }
    for (let j = last.parentIdx + 1; j < parentOldToNew.length; j++) {
      parentPos[j] = last.x + (j - last.parentIdx) * NODE_SPACING_PX;
    }
  }

  const rightmost = Math.max(
    childPos[childPos.length - 1] ?? EDGE_PADDING_PX,
    parentPos[parentPos.length - 1] ?? EDGE_PADDING_PX
  );

  return {
    childPositions: [...childPos].reverse(),
    parentPositions: [...parentPos].reverse(),
    width: rightmost + EDGE_PADDING_PX,
  };
}
