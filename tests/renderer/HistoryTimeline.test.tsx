import type { ReactElement } from 'react';
import { screen, within } from '@testing-library/react';
import {
  ConstellationTimeline,
  HistoryTimeline,
} from '../../src/renderer/components/HistoryTimeline';
import { renderWithMantine } from '../mocks/test-utils';
import { EDGE_PADDING_PX, NODE_SPACING_PX } from '../../src/renderer/components/laneLayout';
import type {
  BranchGraphParentLane,
  MergeFromParent,
  MergeToParent,
  RevisionSummary,
} from '../../src/shared/types';

function makeRevisions(count: number): RevisionSummary[] {
  return Array.from({ length: count }, (_v, i) => ({
    revision: `rev-${String(count - i).padStart(6, '0')}`,
    revisionNumber: count - i,
  }));
}

// Bare element builder — renderWithMantine (and its rerender) supplies the
// MantineProvider wrapper.
function timelineElement(revisions: RevisionSummary[], selectedIndex = 0): ReactElement {
  return (
    <HistoryTimeline
      revisions={revisions}
      current=''
      selectedIndex={selectedIndex}
      onSelect={jest.fn()}
    />
  );
}

// The largest halo drawn around a node (the soft selection ring) has radius
// 5.5 — the edge padding must clear it so nothing clips at the canvas edge.
const LARGEST_HALO_RADIUS = 5.5;

function nodeCenterXs(container: HTMLElement): number[] {
  return within(container)
    .getAllByRole('button')
    .map(node => Number(node.querySelector('circle')?.getAttribute('cx')));
}

describe('HistoryTimeline geometry', () => {
  it('uses a pixel-true viewBox with no aspect-ratio stretching', () => {
    // When: rendering a populated timeline
    const { container } = renderWithMantine(timelineElement(makeRevisions(5)));

    // Then: the svg does not stretch to fill its container — no
    // preserveAspectRatio='none', and its width attribute is a real pixel
    // value matching the viewBox width (not a '100%' percentage)
    const svg = screen.getByRole('img', { name: 'Revision timeline' });
    expect(svg).not.toHaveAttribute('preserveAspectRatio', 'none');
    const viewBox = svg.getAttribute('viewBox');
    expect(viewBox).not.toBeNull();
    const [, , viewBoxWidth] = (viewBox ?? '').split(' ').map(Number);
    const widthAttr = svg.getAttribute('width');
    expect(widthAttr).not.toBe('100%');
    expect(Number(widthAttr)).toBe(viewBoxWidth);
    void container;
  });

  it('places node centers with fixed spacing and edge padding, clearing the largest halo', () => {
    // When: rendering five revisions
    const { container } = renderWithMantine(timelineElement(makeRevisions(5)));
    const svg = screen.getByRole('img', { name: 'Revision timeline' });
    const viewBoxWidth = Number((svg.getAttribute('viewBox') ?? '').split(' ')[2]);

    // Then: node centers are evenly spaced, and the outermost nodes sit far
    // enough from each edge that the selection halo can never clip
    const xs = nodeCenterXs(container).sort((a, b) => a - b);
    expect(xs[0]).toBeGreaterThan(LARGEST_HALO_RADIUS);
    expect(viewBoxWidth - (xs[xs.length - 1] ?? 0)).toBeGreaterThan(LARGEST_HALO_RADIUS);
    // Symmetric padding: the gap from the canvas edges to the first/last node
    // centers is equal at both ends.
    expect(xs[0]).toBeCloseTo(viewBoxWidth - (xs[xs.length - 1] ?? 0), 5);
    // Fixed spacing: consecutive gaps between node centers are all equal.
    const gaps = xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
    gaps.forEach(gap => expect(gap).toBeCloseTo(gaps[0] ?? 0, 5));
  });

  it('renders a node for every revision, however long the history', () => {
    // Given: a history far longer than the old 20-node render cap
    const revisions = makeRevisions(37);

    // When: rendering the timeline
    const { container } = renderWithMantine(timelineElement(revisions));

    // Then: every single revision gets a node — none are dropped
    expect(within(container).getAllByRole('button')).toHaveLength(37);
  });

  it('wraps the svg in a horizontally scrollable container', () => {
    // When: rendering a long timeline
    renderWithMantine(timelineElement(makeRevisions(37)));

    // Then: a Mantine ScrollArea viewport configured for x-scrolling wraps it
    const viewport = document.querySelector('[data-scrollbars="x"]');
    expect(viewport).toBeInTheDocument();
    expect(viewport?.querySelector('svg')).toBeInTheDocument();
  });

  it('auto-scrolls to the newest (rightmost) end on mount', () => {
    // Given: the scroll viewport reports a scrollWidth wider than its client
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      value: 999,
    });

    // When: the timeline mounts
    renderWithMantine(timelineElement(makeRevisions(37)));

    // Then: the viewport is scrolled all the way to the right
    const viewport = document.querySelector('[data-scrollbars="x"]');
    expect(viewport).toHaveProperty('scrollLeft', 999);

    Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
  });

  it('does not reset scroll position when only the selection changes', () => {
    // Given: a mounted timeline whose viewport has been scrolled by the user
    const revisions = makeRevisions(37);
    const { rerender } = renderWithMantine(timelineElement(revisions, 0));
    const viewport = document.querySelector('[data-scrollbars="x"]') as HTMLElement;
    viewport.scrollLeft = 42;

    // When: only the selected index changes, with the same revision list
    rerender(timelineElement(revisions, 5));

    // Then: the scroll position is left untouched
    expect(viewport.scrollLeft).toBe(42);
  });
});

describe('ConstellationTimeline geometry', () => {
  // A branch point that genuinely matches the oldest parent revision below,
  // so the branch-point anchor is real (not the no-anchor fallback).
  const shortParent: BranchGraphParentLane = {
    name: 'main',
    branchPoint: 'p-2',
    revisions: [
      { revision: 'p-0', revisionNumber: 3 },
      { revision: 'p-1', revisionNumber: 2 },
      { revision: 'p-2', revisionNumber: 1 },
    ],
  };

  function constellationElement(
    childCount: number,
    parent: BranchGraphParentLane = shortParent,
    mergesFromParent: ReadonlyArray<MergeFromParent> = []
  ): ReactElement {
    return (
      <ConstellationTimeline
        branchName='feature/x'
        revisions={makeRevisions(childCount)}
        current=''
        parent={parent}
        mergesFromParent={mergesFromParent}
        mergesToParent={[]}
        selectedIndex={0}
        onSelect={jest.fn()}
      />
    );
  }

  it('draws both lanes on one shared pixel canvas, anchored at the same left padding', () => {
    // Given: a child lane much longer than the parent lane
    const { container } = renderWithMantine(constellationElement(12));
    const svg = screen.getByRole('img', { name: /Branch graph/ });
    const viewBoxWidth = Number((svg.getAttribute('viewBox') ?? '').split(' ')[2]);
    const widthAttr = Number(svg.getAttribute('width'));

    // Then: the svg's pixel width is the wider (child) lane's width
    expect(widthAttr).toBe(viewBoxWidth);

    // And: both lanes' oldest node sits at the same left padding — reading
    // the parent's informational nodes (rendered as bare circles) and the
    // child's selectable nodes (rendered as buttons)
    const parentCircles = Array.from(
      container.querySelectorAll('svg circle[r="1.8"], svg circle[r="2.5"]')
    );
    const parentXs = parentCircles.map(c => Number(c.getAttribute('cx'))).sort((a, b) => a - b);
    const childXs = nodeCenterXs(container).sort((a, b) => a - b);

    expect(parentXs[0]).toBeCloseTo(childXs[0] ?? 0, 5);
  });

  it('anchors the merge connector to the TRUE source node, not an unrelated one at the same array index', () => {
    // Given: a long, dense parent lane (main r1..r21, oldest first as r1) and
    // a short child lane (5 nodes) with one merge — mirroring the demo-repo
    // defect: 'child-merge' really merged in main's r12, several nodes deep
    // into the parent lane, not whatever main node happens to share its
    // array index under independent per-lane spacing.
    const parentRevisions = Array.from({ length: 21 }, (_v, i) => ({
      revision: `main-r${21 - i}`,
      revisionNumber: 21 - i,
    }));
    const parent: BranchGraphParentLane = {
      name: 'main',
      branchPoint: 'main-r1',
      revisions: parentRevisions,
    };
    const childRevisions: RevisionSummary[] = [
      { revision: 'child-r5', revisionNumber: 17 },
      { revision: 'child-r4', revisionNumber: 16 },
      { revision: 'child-merge', revisionNumber: 15 },
      { revision: 'child-r2', revisionNumber: 14 },
      { revision: 'child-r1', revisionNumber: 13 },
    ];
    const mergesFromParent: MergeFromParent[] = [
      { child: 'child-merge', parentSource: 'main-r12' },
    ];

    // When: rendering the constellation
    const { container } = renderWithMantine(
      <ConstellationTimeline
        branchName='feature/new-assets'
        revisions={childRevisions}
        current=''
        parent={parent}
        mergesFromParent={mergesFromParent}
        mergesToParent={[]}
        selectedIndex={0}
        onSelect={jest.fn()}
      />
    );

    // Then: the merge connector is a vertical line (x1 === x2) ...
    const mergeLine = container.querySelector('[data-testid="merge-marker"] line');
    expect(mergeLine).not.toBeNull();
    const x1 = Number(mergeLine?.getAttribute('x1'));
    const x2 = Number(mergeLine?.getAttribute('x2'));
    expect(x1).toBe(x2);

    // ... it lands exactly on the TRUE source node (main-r12) ...
    const trueSourceCircle = container.querySelector('[data-revision="main-r12"] circle');
    expect(Number(trueSourceCircle?.getAttribute('cx'))).toBe(x1);

    // ... and NOT where the old defect placed it: a vertical drop straight
    // up from the child's own independently-spaced position (computing the
    // child and parent lane spacing independently of one another made the
    // line imply the wrong main node)
    const mergeChildIdx = childRevisions.findIndex(r => r.revision === 'child-merge');
    const naiveIndependentX =
      EDGE_PADDING_PX + (childRevisions.length - 1 - mergeChildIdx) * NODE_SPACING_PX;
    expect(x1).not.toBe(naiveIndependentX);

    // And: no fallback label is needed since the source is in the window
    expect(
      container.querySelector('[data-testid="merge-marker-fallback-label"]')
    ).not.toBeInTheDocument();
  });

  it('falls back to a labeled, unanchored drop when the merge source is outside the rendered parent window', () => {
    // Given: a parent lane whose branch point elides everything before it,
    // and a merge whose source is one of the elided (pre-branch-point,
    // hence unrendered) revisions
    const parent: BranchGraphParentLane = {
      name: 'main',
      branchPoint: 'main-bp',
      revisions: [
        { revision: 'main-tip', revisionNumber: 5 },
        { revision: 'main-bp', revisionNumber: 4 },
        { revision: 'main-elided', revisionNumber: 3 },
      ],
    };
    const childRevisions: RevisionSummary[] = [
      { revision: 'child-tip', revisionNumber: 2 },
      { revision: 'child-merge', revisionNumber: 1 },
    ];
    const mergesFromParent: MergeFromParent[] = [
      { child: 'child-merge', parentSource: 'main-elided' },
    ];

    // When: rendering the constellation
    const { container } = renderWithMantine(
      <ConstellationTimeline
        branchName='feature/x'
        revisions={childRevisions}
        current=''
        parent={parent}
        mergesFromParent={mergesFromParent}
        mergesToParent={[]}
        selectedIndex={0}
        onSelect={jest.fn()}
      />
    );

    // Then: the drop still renders, vertical, but with a small mono label
    // naming the true (unrendered) source by revision number
    const mergeLine = container.querySelector('[data-testid="merge-marker"] line');
    expect(mergeLine).not.toBeNull();
    expect(mergeLine?.getAttribute('x1')).toBe(mergeLine?.getAttribute('x2'));
    const label = container.querySelector('[data-testid="merge-marker-fallback-label"]');
    expect(label).toBeInTheDocument();
    expect(label?.textContent).toBe('from r3');
  });

  it('anchors an up-merge connector to the true parent merge node, arrow at the top', () => {
    // Given: a parent lane whose newest node (main-merge) accepted a merge
    // from the child's r12
    const parent: BranchGraphParentLane = {
      name: 'main',
      branchPoint: 'main-r1',
      revisions: [
        { revision: 'main-merge', revisionNumber: 13 },
        { revision: 'main-r1', revisionNumber: 1 },
      ],
    };
    const childRevisions: RevisionSummary[] = [
      { revision: 'child-r12', revisionNumber: 12 },
      { revision: 'child-r1', revisionNumber: 1 },
    ];
    const mergesToParent: MergeToParent[] = [{ parent: 'main-merge', childSource: 'child-r12' }];

    // When: rendering the constellation
    const { container } = renderWithMantine(
      <ConstellationTimeline
        branchName='feature/x'
        revisions={childRevisions}
        current=''
        parent={parent}
        mergesFromParent={[]}
        mergesToParent={mergesToParent}
        selectedIndex={0}
        onSelect={jest.fn()}
      />
    );

    // Then: the up-merge connector renders as a vertical line anchored
    // exactly to both the true child source and the parent merge node
    const upLine = container.querySelector('[data-testid="merge-up-marker"] line');
    expect(upLine).not.toBeNull();
    const x1 = Number(upLine?.getAttribute('x1'));
    const x2 = Number(upLine?.getAttribute('x2'));
    expect(x1).toBe(x2);
    const parentCircle = container.querySelector('[data-revision="main-merge"] circle');
    const childNode = screen.getByRole('button', { name: 'Select revision r12' });
    expect(Number(parentCircle?.getAttribute('cx'))).toBe(x1);
    expect(Number(childNode.querySelector('circle')?.getAttribute('cx'))).toBe(x1);

    // And: the arrowhead points UP into the parent node — its apex (tip) is
    // above (smaller y than) its flare (the two base points of the chevron)
    const path = container.querySelector('[data-testid="merge-up-marker"] path');
    const d = path?.getAttribute('d') ?? '';
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number).filter((_v, i) => i % 2 === 1);
    const [flareY1, apexY, flareY2] = ys;
    expect(apexY).toBeLessThan(flareY1 ?? Infinity);
    expect(apexY).toBeLessThan(flareY2 ?? Infinity);

    // And: no fallback label is needed since both ends are in the window
    expect(
      container.querySelector('[data-testid="merge-up-marker-fallback-label"]')
    ).not.toBeInTheDocument();
  });

  it('falls back to a labeled, unanchored up-merge drop when the child source is outside the rendered window', () => {
    // Given: a merge-up pair whose child source isn't among the rendered
    // child revisions (e.g. a revision from beyond the fetched window)
    const parent: BranchGraphParentLane = {
      name: 'main',
      branchPoint: 'main-r1',
      revisions: [
        { revision: 'main-merge', revisionNumber: 8 },
        { revision: 'main-r1', revisionNumber: 1 },
      ],
    };
    const childRevisions: RevisionSummary[] = [
      { revision: 'child-r2', revisionNumber: 2 },
      { revision: 'child-r1', revisionNumber: 1 },
    ];
    const mergesToParent: MergeToParent[] = [
      { parent: 'main-merge', childSource: 'child-unrendered-r7' },
    ];

    // When: rendering the constellation
    const { container } = renderWithMantine(
      <ConstellationTimeline
        branchName='feature/x'
        revisions={childRevisions}
        current=''
        parent={parent}
        mergesFromParent={[]}
        mergesToParent={mergesToParent}
        selectedIndex={0}
        onSelect={jest.fn()}
      />
    );

    // Then: the drop still renders, vertical, above the parent merge node,
    // but with a label since the true source can't be pointed at
    const upLine = container.querySelector('[data-testid="merge-up-marker"] line');
    expect(upLine).not.toBeNull();
    expect(upLine?.getAttribute('x1')).toBe(upLine?.getAttribute('x2'));
    const label = container.querySelector('[data-testid="merge-up-marker-fallback-label"]');
    expect(label).toBeInTheDocument();
  });

  it('resolves a same-node dual-anchor conflict: the down-merge (earlier) stays anchored, the up-merge (later) falls back', () => {
    // Given: 'child-x' is BOTH the target of a down-merge from parent's
    // 'main-a' AND, later, cited as the source of an up-merge into parent's
    // 'main-b' — a ≠ b, so both connectors can't be vertical at once
    const parent: BranchGraphParentLane = {
      name: 'main',
      branchPoint: 'main-r1',
      revisions: [
        { revision: 'main-r5', revisionNumber: 5 },
        { revision: 'main-b', revisionNumber: 4 },
        { revision: 'main-r3', revisionNumber: 3 },
        { revision: 'main-a', revisionNumber: 2 },
        { revision: 'main-r1', revisionNumber: 1 },
      ],
    };
    const childRevisions: RevisionSummary[] = [
      { revision: 'child-r4', revisionNumber: 4 },
      { revision: 'child-r3', revisionNumber: 3 },
      { revision: 'child-x', revisionNumber: 2 },
      { revision: 'child-r1', revisionNumber: 1 },
    ];
    const mergesFromParent: MergeFromParent[] = [{ child: 'child-x', parentSource: 'main-a' }];
    const mergesToParent: MergeToParent[] = [{ parent: 'main-b', childSource: 'child-x' }];

    // When: rendering the constellation
    const { container } = renderWithMantine(
      <ConstellationTimeline
        branchName='feature/x'
        revisions={childRevisions}
        current=''
        parent={parent}
        mergesFromParent={mergesFromParent}
        mergesToParent={mergesToParent}
        selectedIndex={0}
        onSelect={jest.fn()}
      />
    );

    // Then: the down-merge (earlier — baked into child-x's own creation)
    // stays exactly anchored to its true source, with no fallback label
    const downLine = container.querySelector('[data-testid="merge-marker"] line');
    const mainACircle = container.querySelector('[data-revision="main-a"] circle');
    expect(Number(downLine?.getAttribute('x1'))).toBe(Number(mainACircle?.getAttribute('cx')));
    expect(
      container.querySelector('[data-testid="merge-marker-fallback-label"]')
    ).not.toBeInTheDocument();

    // And: the up-merge (later — can only cite child-x after it exists)
    // could NOT also anchor child-x under main-b — child-x's actual x (fixed
    // by the down-merge) does not match the up connector's x — so it falls
    // back to the labeled, unanchored annotation instead of a wrongly-
    // implied vertical
    const upLine = container.querySelector('[data-testid="merge-up-marker"] line');
    const childXNode = screen.getByRole('button', { name: 'Select revision r2' });
    const childXCircle = childXNode.querySelector('circle');
    expect(Number(upLine?.getAttribute('x1'))).not.toBe(Number(childXCircle?.getAttribute('cx')));
    expect(
      container.querySelector('[data-testid="merge-up-marker-fallback-label"]')
    ).toBeInTheDocument();
  });
});

describe('ConstellationTimeline for a freshly forked branch (parent not advanced)', () => {
  // Production shape: assembleBranchGraph feeds the FULL child lineage, which
  // passes through the branch point and shares the parent's pre-fork trunk.
  // For a branch newly created from main, main has NOT advanced past the fork —
  // its tip IS the branch point — so there are no post-fork parent commits.

  function constellation(
    revisions: RevisionSummary[],
    parent: BranchGraphParentLane
  ): ReactElement {
    return (
      <ConstellationTimeline
        branchName='feature/x'
        revisions={revisions}
        current=''
        parent={parent}
        mergesFromParent={[]}
        mergesToParent={[]}
        selectedIndex={0}
        onSelect={jest.fn()}
      />
    );
  }

  // main r1..r3; the branch point is main's TIP (r3) — parent has not advanced.
  const notAdvancedParent: BranchGraphParentLane = {
    name: 'main',
    branchPoint: 'r3',
    revisions: [
      { revision: 'r3', revisionNumber: 3 },
      { revision: 'r2', revisionNumber: 2 },
      { revision: 'r1', revisionNumber: 1 },
    ],
  };

  function parentCircleCount(container: HTMLElement): number {
    return container.querySelectorAll('g[data-revision] circle').length;
  }

  it('renders the parent trunk as a visible multi-node lane, not a single collapsed fork node', () => {
    // Given: a branch with one own commit atop main's full (shared) lineage
    const childFull: RevisionSummary[] = [
      { revision: 'c1', revisionNumber: 4 },
      { revision: 'r3', revisionNumber: 3 },
      { revision: 'r2', revisionNumber: 2 },
      { revision: 'r1', revisionNumber: 1 },
    ];

    // When: rendering the constellation
    const { container } = renderWithMantine(constellation(childFull, notAdvancedParent));

    // Then: the parent lane shows main's trunk (3 nodes), not a lone dot — the
    // user must see the parent's lane, not what reads as a single-lane view
    expect(parentCircleCount(container)).toBe(3);
  });

  it('renders the parent trunk even before the branch has any of its own commits', () => {
    // Given: a fresh branch whose full lineage IS main's lineage (no divergence)
    const childFull: RevisionSummary[] = [
      { revision: 'r3', revisionNumber: 3 },
      { revision: 'r2', revisionNumber: 2 },
      { revision: 'r1', revisionNumber: 1 },
    ];

    // When: rendering the constellation
    const { container } = renderWithMantine(constellation(childFull, notAdvancedParent));

    // Then: the parent lane is still a visible multi-node trunk
    expect(parentCircleCount(container)).toBe(3);
  });

  it('anchors the shared branch-point node at one x on both lanes with a vertical fork connector', () => {
    // Given: a branch with one own commit atop main's shared lineage
    const childFull: RevisionSummary[] = [
      { revision: 'c1', revisionNumber: 4 },
      { revision: 'r3', revisionNumber: 3 },
      { revision: 'r2', revisionNumber: 2 },
      { revision: 'r1', revisionNumber: 1 },
    ];

    // When: rendering the constellation
    const { container } = renderWithMantine(constellation(childFull, notAdvancedParent));

    // Then: the branch point (r3) sits at the same pixel x on the parent lane
    // circle and the child lane node, so the trunk stays parallel
    const parentBranchPoint = container.querySelector('g[data-revision="r3"] circle');
    const childBranchPoint = screen.getByRole('button', { name: 'Select revision r3' });
    const parentX = Number(parentBranchPoint?.getAttribute('cx'));
    const childX = Number(childBranchPoint.querySelector('circle')?.getAttribute('cx'));
    expect(parentX).toBe(childX);

    // And: the fork connector is a vertical line dropping at that shared x
    const connector = container.querySelector('[data-testid="branch-connector"]');
    expect(connector).not.toBeNull();
    expect(Number(connector?.getAttribute('x1'))).toBe(Number(connector?.getAttribute('x2')));
    expect(Number(connector?.getAttribute('x1'))).toBe(parentX);
  });
});
