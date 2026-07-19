import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HistorySection } from '../../src/renderer/components/HistorySection';
import type { HistorySectionProps } from '../../src/renderer/components/HistorySection';
import type { BranchGraphParentLane, RevisionSummary } from '../../src/shared/types';

const revisions: RevisionSummary[] = [
  { revision: 'aaaaaaaaaaaaaaaa', revisionNumber: 3 },
  { revision: 'bbbbbbbbbbbbbbbb', revisionNumber: 2, message: 'Fix bug' },
  { revision: 'cccccccccccccccc', revisionNumber: 1 },
];

const parentLane: BranchGraphParentLane = {
  name: 'main',
  branchPoint: 'cccccccccccccccc',
  revisions: [
    { revision: 'mmmmmmmmmmmmmmmm', revisionNumber: 9 },
    { revision: 'cccccccccccccccc', revisionNumber: 1 },
  ],
};

function baseProps(overrides: Partial<HistorySectionProps> = {}): HistorySectionProps {
  return {
    branchName: 'feature/x',
    revisions: [],
    current: '',
    mergesFromParent: [],
    mergesToParent: [],
    isLoading: false,
    selectedIndex: 0,
    onSelect: jest.fn(),
    onSyncToSelected: jest.fn(),
    ...overrides,
  };
}

// The shared x of a rendered element's first line/circle — the constellation
// draws connectors and nodes at exact pixel positions, so alignment is
// asserted by comparing these.
function xOf(selector: string): number {
  const el = document.querySelector(selector);
  const value = el?.getAttribute('x1') ?? el?.getAttribute('cx');
  expect(value).not.toBeNull();
  return Number(value);
}

// A child-lane node's x, looked up via its accessible label.
function childNodeX(revisionNumber: number): number {
  const node = screen.getByRole('button', { name: `Select revision r${revisionNumber}` });
  const circle = node.querySelector('circle');
  expect(circle).not.toBeNull();
  return Number(circle?.getAttribute('cx'));
}

function renderHistorySection(props: HistorySectionProps): void {
  render((<MantineProvider>{<HistorySection {...props} />}</MantineProvider>) as ReactElement);
}

describe('HistorySection', () => {
  it('shows a dimmed empty state when there is no history', () => {
    // When: rendering with no revisions, not loading
    renderHistorySection(baseProps({ revisions: [], isLoading: false }));

    // Then: the dimmed empty-state message is shown
    expect(screen.getByText('No history yet')).toBeInTheDocument();
  });

  it('shows a loader while loading, and no empty state', () => {
    // When: rendering while loading
    renderHistorySection(baseProps({ isLoading: true }));

    // Then: the loader is shown, not the empty state
    expect(screen.getByLabelText('Loading history')).toBeInTheDocument();
    expect(screen.queryByText('No history yet')).not.toBeInTheDocument();
  });

  it('renders ledger rows newest-first, preserving the incoming order', () => {
    // When: rendering a populated, newest-first list
    renderHistorySection(baseProps({ revisions, selectedIndex: 0 }));

    // Then: the revision-number rows render in the same order as the array
    const numbers = screen.getAllByText(/^r\d+$/);
    expect(numbers.map(el => el.textContent)).toEqual(['r3', 'r2', 'r1']);
  });

  it("renders a row's message when present, and the short hash when absent", () => {
    // When: rendering revisions where only the middle one has a message
    renderHistorySection(baseProps({ revisions, selectedIndex: 0 }));

    // Then: the message renders for that row exactly once (it is not the
    // selected revision, so the header must not repeat it), and short
    // hashes render for the rest
    expect(screen.getAllByText('Fix bug')).toHaveLength(1);
    expect(screen.getByText('aaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('cccccccc')).toBeInTheDocument();
  });

  it('falls back to the short hash for an empty-string message', () => {
    // Given: a sync-generated merge revision whose message is empty
    const merge = [
      {
        revision: 'dddddddd'.repeat(8),
        revisionNumber: 11,
        message: '',
      },
    ];

    // When: rendering it
    renderHistorySection(baseProps({ revisions: merge, selectedIndex: 0 }));

    // Then: the row and header caption both show the short hash, not a blank
    // (regex, not exact string — the header renders "dddddddd · r11")
    expect(screen.getAllByText(/dddddddd/)).toHaveLength(2);
  });

  it('shows just the revision number as the row secondary when no timestamp is present', () => {
    // When: rendering a revision with no timestamp
    renderHistorySection(baseProps({ revisions, selectedIndex: 0 }));

    // Then: the secondary text is the bare revision number
    expect(screen.getByText('r1')).toBeInTheDocument();
  });

  it('shows "r<n> · <relative time>" as the row secondary when a timestamp is present', () => {
    // Given: "now" is fixed, and a revision timestamped 2 hours earlier
    const now = new Date('2026-07-18T12:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const timestamped: RevisionSummary[] = [
      { revision: 'dddddddddddddddd', revisionNumber: 5, timestamp: now - 2 * 60 * 60 * 1000 },
    ];

    // When: rendering that revision
    renderHistorySection(baseProps({ revisions: timestamped, selectedIndex: 0 }));

    // Then: the secondary text combines the revision number and relative time
    expect(screen.getByText('r5 · 2h ago')).toBeInTheDocument();

    jest.restoreAllMocks();
  });

  it('shows the selected revision short-hash and number in the header when it has no message', () => {
    // When: rendering with the oldest (message-less) revision selected
    renderHistorySection(baseProps({ revisions, selectedIndex: 2 }));

    // Then: the header falls back to short hash and revision number
    expect(screen.getByText('cccccccc · r1')).toBeInTheDocument();
  });

  it("shows the selected revision's message in the header when present", () => {
    // When: rendering with the messaged revision selected
    renderHistorySection(baseProps({ revisions, selectedIndex: 1 }));

    // Then: the header shows the message instead of the hash (once in the
    // header caption, once in the row itself)
    expect(screen.getAllByText('Fix bug')).toHaveLength(2);
    expect(screen.queryByText('bbbbbbbb · r2')).not.toBeInTheDocument();
  });

  it('calls onSelect with the row index when a ledger row is clicked', async () => {
    // Given: a rendered, populated history section
    const user = userEvent.setup();
    const onSelect = jest.fn();
    renderHistorySection(baseProps({ revisions, onSelect }));

    // When: clicking the last (oldest) row
    await user.click(screen.getByText('cccccccc'));

    // Then: onSelect fires with that row's index
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('calls onSelect with the node index when a timeline node is clicked', async () => {
    // Given: a rendered, populated history section
    const user = userEvent.setup();
    const onSelect = jest.fn();
    renderHistorySection(baseProps({ revisions, onSelect }));

    // When: clicking the timeline node for the oldest revision
    await user.click(screen.getByRole('button', { name: 'Select revision r1' }));

    // Then: onSelect fires with that revision's index
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('marks the selected ledger row', () => {
    // When: rendering with the oldest revision selected
    renderHistorySection(baseProps({ revisions, selectedIndex: 2 }));

    // Then: that row is marked selected, others are not
    const selectedRow = screen.getByText('cccccccc').closest('[data-selected]');
    expect(selectedRow).toHaveAttribute('data-selected', 'true');
    const otherRow = screen.getByText('aaaaaaaa').closest('div');
    expect(otherRow).not.toHaveAttribute('data-selected');
  });

  it('marks the current revision row distinctly, even when a different row is selected', () => {
    // Given: the current revision is the middle one, but the newest is selected
    renderHistorySection(baseProps({ revisions, current: 'bbbbbbbbbbbbbbbb', selectedIndex: 0 }));

    // Then: the current row carries the current marker and a 'current' badge
    const currentRow = screen.getByText('Fix bug').closest('[data-current]');
    expect(currentRow).toHaveAttribute('data-current', 'true');
    expect(screen.getByText('current')).toBeInTheDocument();

    // And: the selected (newest) row is not the current one
    const selectedRow = screen.getByText('aaaaaaaa').closest('[data-selected]');
    expect(selectedRow).toHaveAttribute('data-selected', 'true');
    expect(selectedRow).not.toHaveAttribute('data-current');
  });

  it('marks the current revision node on the timeline', () => {
    // When: the current revision is the newest one
    renderHistorySection(baseProps({ revisions, current: 'aaaaaaaaaaaaaaaa', selectedIndex: 2 }));

    // Then: the timeline node for that revision is flagged current
    const currentNode = screen.getByRole('button', { name: 'Select revision r3' });
    expect(currentNode).toHaveAttribute('data-current', 'true');
    const otherNode = screen.getByRole('button', { name: 'Select revision r1' });
    expect(otherNode).not.toHaveAttribute('data-current');
  });

  it('shows a "Sync to r<n>" action when the selection differs from the current revision', async () => {
    // Given: current is the newest, but an older revision is selected
    const user = userEvent.setup();
    const onSyncToSelected = jest.fn();
    renderHistorySection(
      baseProps({
        revisions,
        current: 'aaaaaaaaaaaaaaaa',
        selectedIndex: 2,
        onSyncToSelected,
      })
    );

    // When: clicking the sync-to-selected action
    const syncButton = screen.getByRole('button', { name: 'Sync to r1' });
    await user.click(syncButton);

    // Then: it opens the sync flow prefilled with the selected revision hash
    expect(onSyncToSelected).toHaveBeenCalledWith('cccccccccccccccc');
  });

  it('does not show the sync-to-selected action when the selection is the current revision', () => {
    // When: the selected revision is also the current one
    renderHistorySection(baseProps({ revisions, current: 'aaaaaaaaaaaaaaaa', selectedIndex: 0 }));

    // Then: no sync action is offered
    expect(screen.queryByRole('button', { name: /^Sync to r/ })).not.toBeInTheDocument();
  });

  it('renders a two-lane constellation with branch-point and merge connectors when a parent is present', () => {
    // Given: a child branch over a parent, with one merge accepted from the parent
    renderHistorySection(
      baseProps({
        revisions,
        parent: parentLane,
        mergesFromParent: [{ child: 'bbbbbbbbbbbbbbbb', parentSource: 'mmmmmmmmmmmmmmmm' }],
        current: 'aaaaaaaaaaaaaaaa',
      })
    );

    // Then: both lane labels render, plus the branch-point and merge connectors
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('feature/x')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="branch-connector"]')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="merge-marker"]')).toBeInTheDocument();
  });

  it('keeps the child lane going past a merge down — later nodes render right of the anchored merge', () => {
    // Given: a merge from the parent at r2, with r3 and r4 landing after it
    const continuing: RevisionSummary[] = [
      { revision: 'eeeeeeeeeeeeeeee', revisionNumber: 4 },
      { revision: 'dddddddddddddddd', revisionNumber: 3 },
      { revision: 'bbbbbbbbbbbbbbbb', revisionNumber: 2, message: 'Merge from main' },
      { revision: 'cccccccccccccccc', revisionNumber: 1 },
    ];
    renderHistorySection(
      baseProps({
        revisions: continuing,
        parent: parentLane,
        mergesFromParent: [{ child: 'bbbbbbbbbbbbbbbb', parentSource: 'mmmmmmmmmmmmmmmm' }],
      })
    );

    // Then: the merge marker is anchored to its true parent source — same x
    // as the parent-lane node it merged from, with no fallback label
    const mergeX = xOf('[data-testid="merge-marker"] line');
    expect(mergeX).toBe(xOf('g[data-revision="mmmmmmmmmmmmmmmm"] circle'));
    expect(
      document.querySelector('[data-testid="merge-marker-fallback-label"]')
    ).not.toBeInTheDocument();

    // And: the post-merge revisions continue to the right of the merge,
    // newest furthest out
    expect(childNodeX(3)).toBeGreaterThan(childNodeX(2));
    expect(childNodeX(4)).toBeGreaterThan(childNodeX(3));
    expect(childNodeX(2)).toBe(mergeX);
  });

  it('renders a merge up (child to parent) as an anchored rising connector', () => {
    // Given: r2 on the child was accepted into the parent as merge revision
    // 'qqqq…' (newer than the branch point on the parent lane)
    const upParent: BranchGraphParentLane = {
      name: 'main',
      branchPoint: 'cccccccccccccccc',
      revisions: [
        { revision: 'qqqqqqqqqqqqqqqq', revisionNumber: 10 },
        { revision: 'mmmmmmmmmmmmmmmm', revisionNumber: 9 },
        { revision: 'cccccccccccccccc', revisionNumber: 1 },
      ],
    };
    renderHistorySection(
      baseProps({
        revisions,
        parent: upParent,
        mergesToParent: [{ parent: 'qqqqqqqqqqqqqqqq', childSource: 'bbbbbbbbbbbbbbbb' }],
      })
    );

    // Then: the merge-up marker renders, anchored so the child source node,
    // the connector, and the parent merge node all share one x
    const upX = xOf('[data-testid="merge-up-marker"] line');
    expect(upX).toBe(xOf('g[data-revision="qqqqqqqqqqqqqqqq"] circle'));
    expect(upX).toBe(childNodeX(2));
  });

  it('keeps both lanes going after a merge down and a merge back up', () => {
    // Given: fork at r1 → merge down at r2 (from parent r9) → child continues
    // at r3 → merge up into parent r10 (from child r3) → both lanes continue
    // (child r4, parent r11)
    const childFlow: RevisionSummary[] = [
      { revision: 'eeeeeeeeeeeeeeee', revisionNumber: 4 },
      { revision: 'dddddddddddddddd', revisionNumber: 3 },
      { revision: 'bbbbbbbbbbbbbbbb', revisionNumber: 2 },
      { revision: 'cccccccccccccccc', revisionNumber: 1 },
    ];
    const parentFlow: BranchGraphParentLane = {
      name: 'main',
      branchPoint: 'cccccccccccccccc',
      revisions: [
        { revision: 'rrrrrrrrrrrrrrrr', revisionNumber: 11 },
        { revision: 'qqqqqqqqqqqqqqqq', revisionNumber: 10 },
        { revision: 'mmmmmmmmmmmmmmmm', revisionNumber: 9 },
        { revision: 'cccccccccccccccc', revisionNumber: 1 },
      ],
    };
    renderHistorySection(
      baseProps({
        revisions: childFlow,
        parent: parentFlow,
        mergesFromParent: [{ child: 'bbbbbbbbbbbbbbbb', parentSource: 'mmmmmmmmmmmmmmmm' }],
        mergesToParent: [{ parent: 'qqqqqqqqqqqqqqqq', childSource: 'dddddddddddddddd' }],
      })
    );

    // Then: both merge connectors render, each anchored to its true source
    const downX = xOf('[data-testid="merge-marker"] line');
    const upX = xOf('[data-testid="merge-up-marker"] line');
    expect(downX).toBe(xOf('g[data-revision="mmmmmmmmmmmmmmmm"] circle'));
    expect(downX).toBe(childNodeX(2));
    expect(upX).toBe(xOf('g[data-revision="qqqqqqqqqqqqqqqq"] circle'));
    expect(upX).toBe(childNodeX(3));

    // And: the graph reads chronologically — fork, then merge down, then
    // merge up, with both lanes continuing past the last merge
    const forkX = childNodeX(1);
    expect(downX).toBeGreaterThan(forkX);
    expect(upX).toBeGreaterThan(downX);
    expect(childNodeX(4)).toBeGreaterThan(upX);
    expect(Number(xOf('g[data-revision="rrrrrrrrrrrrrrrr"] circle'))).toBeGreaterThan(upX);
  });

  it('renders only the single lane when there is no parent', () => {
    // When: rendering without a parent lane
    renderHistorySection(baseProps({ revisions }));

    // Then: no constellation connectors are drawn
    expect(document.querySelector('[data-testid="branch-connector"]')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Revision timeline' })).toBeInTheDocument();
  });
});
