import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pill } from '../../src/renderer/components/Pill';
import type { ActionSignals } from '../../src/renderer/utils/actionSignals';
import { makeRepository } from '../mocks/repository-fixture';

const QUIET: ActionSignals = { syncNeeded: false, uncommitted: false, unpushed: false };

const repository = makeRepository();

function renderPill(ui: ReactElement): ReturnType<typeof render> {
  return render((<MantineProvider>{ui}</MantineProvider>) as ReactElement);
}

// Read the -webkit-app-region inline style off an element (jsdom stores unknown
// style properties as plain JS props on the style object).
function appRegion(element: Element): string | undefined {
  return ((element as HTMLElement).style as unknown as { WebkitAppRegion?: string })
    .WebkitAppRegion;
}

describe('Pill', () => {
  it('renders the branch name', () => {
    // When: rendering the pill for a branch
    renderPill(
      <Pill branchName='feature/login' signals={QUIET} onClose={jest.fn()} repository={null} />
    );

    // Then: the branch name is shown
    expect(screen.getByText('feature/login')).toBeInTheDocument();
  });

  it('falls back to "main" when no branch name is provided', () => {
    // When: rendering the pill with an empty branch name
    renderPill(<Pill branchName='' signals={QUIET} onClose={jest.fn()} repository={null} />);

    // Then: it shows the default branch label
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('stays quiet when nothing is actionable — no signal glyphs at all', () => {
    // When: rendering with all signals clear
    renderPill(<Pill branchName='main' signals={QUIET} onClose={jest.fn()} repository={null} />);

    // Then: no action glyph is rendered — a quiet pill means all clear
    expect(screen.queryByLabelText('Sync needed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Commits to push')).not.toBeInTheDocument();
  });

  it('shows the sync glyph when the workspace is on outdated state', () => {
    // Given: the sync signal is active
    const signals: ActionSignals = { ...QUIET, syncNeeded: true };

    // When: rendering the pill
    renderPill(<Pill branchName='main' signals={signals} onClose={jest.fn()} repository={null} />);

    // Then: only the sync glyph is present
    expect(screen.getByLabelText('Sync needed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Commits to push')).not.toBeInTheDocument();
  });

  it('shows the commit glyph when there is local uncommitted work', () => {
    // Given: the commit signal is active
    const signals: ActionSignals = { ...QUIET, uncommitted: true };

    // When: rendering the pill
    renderPill(<Pill branchName='main' signals={signals} onClose={jest.fn()} repository={null} />);

    // Then: the commit glyph is present
    expect(screen.getByLabelText('Uncommitted changes')).toBeInTheDocument();
  });

  it('shows the push glyph when local commits are unpushed', () => {
    // Given: the push signal is active
    const signals: ActionSignals = { ...QUIET, unpushed: true };

    // When: rendering the pill
    renderPill(<Pill branchName='main' signals={signals} onClose={jest.fn()} repository={null} />);

    // Then: the push glyph is present
    expect(screen.getByLabelText('Commits to push')).toBeInTheDocument();
  });

  it('shows all three glyphs when everything is actionable at once', () => {
    // Given: every signal active
    const signals: ActionSignals = { syncNeeded: true, uncommitted: true, unpushed: true };

    // When: rendering the pill
    renderPill(<Pill branchName='main' signals={signals} onClose={jest.fn()} repository={null} />);

    // Then: all three glyphs render side by side
    expect(screen.getByLabelText('Sync needed')).toBeInTheDocument();
    expect(screen.getByLabelText('Uncommitted changes')).toBeInTheDocument();
    expect(screen.getByLabelText('Commits to push')).toBeInTheDocument();
  });

  it('does NOT make its root a native -webkit-app-region drag region (regression guard)', () => {
    // Regression guard for the click-expand bug: a native drag region routes
    // real mouse events to the OS, so the renderer never sees pointerdown/click
    // and click-to-expand silently dies for a human. The pill must be dragged
    // manually instead, so its root must carry no `-webkit-app-region: drag`.
    const { container } = renderPill(
      <Pill branchName='main' signals={QUIET} onClose={jest.fn()} repository={null} />
    );

    // Then: no element in the pill declares a drag region
    const dragRegions = Array.from(container.querySelectorAll('*')).filter(
      element => appRegion(element) === 'drag'
    );
    expect(dragRegions).toHaveLength(0);
  });

  it('shows the repository name as an eyebrow above the branch name', () => {
    // When: rendering with a selected repository
    renderPill(
      <Pill branchName='main' signals={QUIET} onClose={jest.fn()} repository={repository} />
    );

    // Then: the repo name renders alongside the branch
    expect(screen.getByText('MyRepo')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('reveals the repository local path in a tooltip on the repo name', async () => {
    // Given: a pill with a selected repository
    const user = userEvent.setup();
    renderPill(
      <Pill branchName='main' signals={QUIET} onClose={jest.fn()} repository={repository} />
    );

    // When: hovering the repo name eyebrow
    await user.hover(screen.getByText('MyRepo'));

    // Then: the tooltip carries the local checkout path
    expect(await screen.findByText('/tmp/my-repo')).toBeInTheDocument();
  });

  it('invokes onClose when the close control is clicked', async () => {
    // Given: a pill with a close handler
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderPill(<Pill branchName='main' signals={QUIET} onClose={onClose} repository={null} />);

    // When: clicking the close control
    await user.click(screen.getByRole('button', { name: 'Close' }));

    // Then: the handler fires
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
