import {
  EDGE_PADDING_PX,
  NODE_SPACING_PX,
  computeLaneLayout,
} from '../../src/renderer/components/laneLayout';
import type { LaneLayoutAnchor } from '../../src/renderer/components/laneLayout';

// Hashes are newest-first, matching the SDK walk order the real component
// consumes: index 0 is the tip, the last index is the oldest revision.
function hashes(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_v, i) => `${prefix}${count - i}`);
}

describe('computeLaneLayout', () => {
  it('aligns each anchor pair to the exact same x on both lanes', () => {
    // Given: a child merge (c2) whose true source is the parent's p3, plus
    // the branch-point anchor tying the child's oldest node to the parent's
    // oldest rendered node
    const child = hashes('c', 4); // c4 c3 c2 c1, oldest = c1
    const parent = hashes('p', 5); // p5 p4 p3 p2 p1, oldest = p1
    const anchors: LaneLayoutAnchor[] = [
      { child: 'c1', parent: 'p1' },
      { child: 'c2', parent: 'p3' },
    ];

    // When: computing the shared layout
    const layout = computeLaneLayout(child, parent, anchors);

    // Then: both anchor pairs land at identical x on each lane
    const childIdxC1 = child.indexOf('c1');
    const parentIdxP1 = parent.indexOf('p1');
    const childIdxC2 = child.indexOf('c2');
    const parentIdxP3 = parent.indexOf('p3');
    expect(layout.childPositions[childIdxC1]).toBe(layout.parentPositions[parentIdxP1]);
    expect(layout.childPositions[childIdxC2]).toBe(layout.parentPositions[parentIdxP3]);
  });

  it('never compresses spacing below the base — only ever expands it', () => {
    // Given: a segment where the parent has more in-between nodes than the
    // child (child sparser, so its single in-between node must be pushed to
    // spread across a wider span)
    const child = hashes('c', 3); // c3 c2 c1
    const parent = hashes('p', 5); // p5 p4 p3 p2 p1
    const anchors: LaneLayoutAnchor[] = [
      { child: 'c1', parent: 'p1' },
      { child: 'c3', parent: 'p5' },
    ];

    // When: computing the layout
    const layout = computeLaneLayout(child, parent, anchors);

    // Then: every consecutive gap on both lanes is >= the base spacing
    for (const positions of [layout.childPositions, layout.parentPositions]) {
      const sorted = [...positions].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(NODE_SPACING_PX - 1e-9);
      }
    }
  });

  it('spreads the sparser lane evenly and keeps the denser lane at base spacing', () => {
    // Given: 3 child nodes between anchors vs. 1 parent node between the
    // same anchors — the child is denser
    const child = hashes('c', 5); // c5 c4 c3 c2 c1
    const parent = hashes('p', 3); // p3 p2 p1
    const anchors: LaneLayoutAnchor[] = [
      { child: 'c1', parent: 'p1' },
      { child: 'c5', parent: 'p3' },
    ];

    // When: computing the layout
    const layout = computeLaneLayout(child, parent, anchors);

    // Then: the denser child lane's interior gaps are exactly base spacing
    const c = [...layout.childPositions].reverse(); // oldest -> newest
    for (let i = 1; i < c.length; i++) {
      expect((c[i] ?? 0) - (c[i - 1] ?? 0)).toBeCloseTo(NODE_SPACING_PX, 5);
    }
    // And: the sparser parent lane's single interior gap spans the full
    // segment evenly (wider than base spacing)
    const p = [...layout.parentPositions].reverse();
    const parentGap = (p[1] ?? 0) - (p[0] ?? 0);
    expect(parentGap).toBeGreaterThan(NODE_SPACING_PX);
    expect((p[2] ?? 0) - (p[1] ?? 0)).toBeCloseTo(parentGap, 5);
  });

  it('continues each lane independently, at base spacing, before the first anchor', () => {
    // Given: the child has one extra (older) node before the anchor that
    // the parent doesn't have
    const child = hashes('c', 2); // c2 c1 — c1 is one node before the anchor
    const parent = hashes('p', 1); // p1 only — p1 IS the anchor
    const anchors: LaneLayoutAnchor[] = [{ child: 'c2', parent: 'p1' }];

    // When: computing the layout
    const layout = computeLaneLayout(child, parent, anchors);

    // Then: the anchor (c2/p1) still lines up
    expect(layout.childPositions[0]).toBe(layout.parentPositions[0]);
    // And: the child's pre-anchor node (c1) sits exactly one base-spacing
    // step to the left of the anchor, independent of the parent lane
    const anchorX = layout.childPositions[0] ?? 0;
    expect(anchorX - (layout.childPositions[1] ?? 0)).toBeCloseTo(NODE_SPACING_PX, 5);
  });

  it('continues each lane independently, at base spacing, after the last anchor', () => {
    // Given: only the child has newer nodes after the anchor
    const child = hashes('c', 2); // c2 c1 — c2 is one node after the anchor
    const parent = hashes('p', 1); // p1 only — p1 IS the anchor
    const anchors: LaneLayoutAnchor[] = [{ child: 'c1', parent: 'p1' }];

    // When: computing the layout
    const layout = computeLaneLayout(child, parent, anchors);

    // Then: the anchor (c1/p1) lines up
    expect(layout.childPositions[1]).toBe(layout.parentPositions[0]);
    // And: the child's post-anchor node (c2) sits one base-spacing step to
    // the right, independent of the parent lane's (empty) continuation
    const anchorX = layout.childPositions[1] ?? 0;
    expect((layout.childPositions[0] ?? 0) - anchorX).toBeCloseTo(NODE_SPACING_PX, 5);
  });

  it('lays out two lanes independently at base spacing when there are no anchors', () => {
    // When: computing a layout with no anchors at all
    const child = hashes('c', 3);
    const parent = hashes('p', 3);
    const layout = computeLaneLayout(child, parent, []);

    // Then: both lanes start at the edge padding and use base spacing
    const c = [...layout.childPositions].reverse();
    const p = [...layout.parentPositions].reverse();
    expect(c[0]).toBe(EDGE_PADDING_PX);
    expect(p[0]).toBe(EDGE_PADDING_PX);
    expect((c[1] ?? 0) - (c[0] ?? 0)).toBeCloseTo(NODE_SPACING_PX, 5);
  });

  it('keeps ordering strictly monotonic on both lanes', () => {
    // Given: a mix of dense/sparse segments on both sides
    const child = hashes('c', 6);
    const parent = hashes('p', 4);
    const anchors: LaneLayoutAnchor[] = [
      { child: 'c1', parent: 'p1' },
      { child: 'c3', parent: 'p2' },
      { child: 'c6', parent: 'p4' },
    ];

    // When: computing the layout
    const layout = computeLaneLayout(child, parent, anchors);

    // Then: positions strictly increase newest-to-oldest reversed (i.e.
    // oldest-to-newest is strictly increasing)
    for (const positions of [layout.childPositions, layout.parentPositions]) {
      const oldToNew = [...positions].reverse();
      for (let i = 1; i < oldToNew.length; i++) {
        expect(oldToNew[i]).toBeGreaterThan(oldToNew[i - 1] ?? -Infinity);
      }
    }
  });

  it('resolves a same-node dual-anchor conflict in favor of the earlier (chronologically-first) anchor', () => {
    // Given: c2 is BOTH the target of a down-merge (anchored to parent's p2)
    // AND, later, cited as the source of an up-merge into parent's p4 — two
    // anchors on the SAME child index that can't both be satisfied (p2 and
    // p4 sit at different x). Anchors are supplied in chronological order:
    // the branch point, then the down-merge (baked into c2's own creation),
    // then the up-merge (which can only reference c2 after it exists).
    const child = hashes('c', 4); // c4 c3 c2 c1, oldest = c1
    const parent = hashes('p', 5); // p5 p4 p3 p2 p1, oldest = p1
    const anchors: LaneLayoutAnchor[] = [
      { child: 'c1', parent: 'p1' }, // branch point
      { child: 'c2', parent: 'p2' }, // down-merge: c2 accepted p2 from parent
      { child: 'c2', parent: 'p4' }, // up-merge: c2 later cited as source of p4
    ];

    // When: computing the shared layout
    const layout = computeLaneLayout(child, parent, anchors);

    // Then: the earlier (down-merge) anchor keeps its exact alignment...
    const childIdxC2 = child.indexOf('c2');
    const parentIdxP2 = parent.indexOf('p2');
    const parentIdxP4 = parent.indexOf('p4');
    expect(layout.childPositions[childIdxC2]).toBe(layout.parentPositions[parentIdxP2]);
    // ...and the later, conflicting anchor is NOT honored — c2 does not
    // land under p4 too (that would require occupying two x positions)
    expect(layout.childPositions[childIdxC2]).not.toBe(layout.parentPositions[parentIdxP4]);
  });

  it('sets the canvas width to the rightmost node plus the edge padding', () => {
    // When: computing a layout with no anchors
    const layout = computeLaneLayout(hashes('c', 3), hashes('p', 2), []);

    // Then: width is the further-extending lane's newest node + padding
    const rightmostChild = layout.childPositions[0] ?? 0;
    const rightmostParent = layout.parentPositions[0] ?? 0;
    expect(layout.width).toBe(Math.max(rightmostChild, rightmostParent) + EDGE_PADDING_PX);
  });
});
