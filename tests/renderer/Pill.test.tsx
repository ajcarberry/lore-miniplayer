import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pill } from '../../src/renderer/components/Pill';
import type { PillProps } from '../../src/renderer/components/Pill';
import type { ActionSignals } from '../../src/renderer/utils/actionSignals';
import { makeRepository } from '../mocks/repository-fixture';
import { renderWithMantine } from './test-utils';

const QUIET: ActionSignals = { syncNeeded: false, uncommitted: false, unpushed: false };

const repository = makeRepository();

function baseProps(overrides: Partial<PillProps> = {}): PillProps {
  return {
    branchName: 'main',
    signals: QUIET,
    onClose: jest.fn(),
    repository: null,
    needsYouCount: 0,
    activeCount: 0,
    onOpenMissionControl: jest.fn(),
    ...overrides,
  };
}

function renderPill(overrides: Partial<PillProps> = {}): ReturnType<typeof renderWithMantine> {
  return renderWithMantine(<Pill {...baseProps(overrides)} />);
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
    renderPill({ branchName: 'feature/login' });

    // Then: the branch name is shown
    expect(screen.getByText('feature/login')).toBeInTheDocument();
  });

  it('falls back to "main" when no branch name is provided', () => {
    // When: rendering the pill with an empty branch name
    renderPill({ branchName: '' });

    // Then: it shows the default branch label
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('stays quiet when nothing is actionable — no signal glyphs at all', () => {
    // When: rendering with all signals clear
    renderPill();

    // Then: no action glyph is rendered — a quiet pill means all clear
    expect(screen.queryByLabelText('Sync needed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Commits to push')).not.toBeInTheDocument();
  });

  it('shows the sync glyph when the workspace is on outdated state', () => {
    // Given: the sync signal is active
    const signals: ActionSignals = { ...QUIET, syncNeeded: true };

    // When: rendering the pill
    renderPill({ signals });

    // Then: only the sync glyph is present
    expect(screen.getByLabelText('Sync needed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Commits to push')).not.toBeInTheDocument();
  });

  it('shows the commit glyph when there is local uncommitted work', () => {
    // Given: the commit signal is active
    const signals: ActionSignals = { ...QUIET, uncommitted: true };

    // When: rendering the pill
    renderPill({ signals });

    // Then: the commit glyph is present
    expect(screen.getByLabelText('Uncommitted changes')).toBeInTheDocument();
  });

  it('shows the push glyph when local commits are unpushed', () => {
    // Given: the push signal is active
    const signals: ActionSignals = { ...QUIET, unpushed: true };

    // When: rendering the pill
    renderPill({ signals });

    // Then: the push glyph is present
    expect(screen.getByLabelText('Commits to push')).toBeInTheDocument();
  });

  it('shows all three glyphs when everything is actionable at once', () => {
    // Given: every signal active
    const signals: ActionSignals = { syncNeeded: true, uncommitted: true, unpushed: true };

    // When: rendering the pill
    renderPill({ signals });

    // Then: all three glyphs render side by side
    expect(screen.getByLabelText('Sync needed')).toBeInTheDocument();
    expect(screen.getByLabelText('Uncommitted changes')).toBeInTheDocument();
    expect(screen.getByLabelText('Commits to push')).toBeInTheDocument();
  });

  it('marks the pill bar with the sync notice so the CSS pulse can engage', () => {
    // Given: the workspace is behind the remote
    const signals: ActionSignals = { ...QUIET, syncNeeded: true };

    // When: rendering the pill
    const { container } = renderPill({ signals });

    // Then: the pill bar carries the notice attribute the pulse keyframes key on
    expect(container.querySelector('.morph-pill-bar')).toHaveAttribute('data-notice', 'sync');
  });

  it('carries no notice mark when the workspace is not behind the remote and no agent needs you', () => {
    // Given: other signals may be active, but sync is not needed
    const signals: ActionSignals = { ...QUIET, uncommitted: true, unpushed: true };

    // When: rendering the pill
    const { container } = renderPill({ signals });

    // Then: no notice attribute — the pill must not pulse
    expect(container.querySelector('.morph-pill-bar')).not.toHaveAttribute('data-notice');
  });

  it('does NOT make its root a native -webkit-app-region drag region (regression guard)', () => {
    // Regression guard for the click-expand bug: a native drag region routes
    // real mouse events to the OS, so the renderer never sees pointerdown/click
    // and click-to-expand silently dies for a human. The pill must be dragged
    // manually instead, so its root must carry no `-webkit-app-region: drag`.
    const { container } = renderPill();

    // Then: no element in the pill declares a drag region
    const dragRegions = Array.from(container.querySelectorAll('*')).filter(
      element => appRegion(element) === 'drag'
    );
    expect(dragRegions).toHaveLength(0);
  });

  it('shows the repository name as an eyebrow above the branch name', () => {
    // When: rendering with a selected repository
    renderPill({ repository });

    // Then: the repo name renders alongside the branch
    expect(screen.getByText('MyRepo')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('combines the repo name with the workspace name when it differs meaningfully', () => {
    // Given: an attached sibling workspace named "adfa" of repo
    // "demo-project", on a branch that is neither "adfa" nor "demo-project"
    const attachedSibling = makeRepository({
      name: 'adfa',
      url: 'lores://lore.example.com/demo-project',
    });

    // When: rendering the pill for that workspace
    renderPill({ repository: attachedSibling, branchName: 'main' });

    // Then: the eyebrow shows the repo name, not the bare workspace name
    expect(screen.getByText('demo-project · adfa')).toBeInTheDocument();
    expect(screen.queryByText('adfa')).not.toBeInTheDocument();
  });

  it('reveals the repository local path in a tooltip on the repo name', async () => {
    // Given: a pill with a selected repository
    const user = userEvent.setup();
    renderPill({ repository });

    // When: hovering the repo name eyebrow
    await user.hover(screen.getByText('MyRepo'));

    // Then: the tooltip carries the local checkout path
    expect(await screen.findByText('/tmp/my-repo')).toBeInTheDocument();
  });

  it('invokes onClose when the close control is clicked', async () => {
    // Given: a pill with a close handler
    const onClose = jest.fn();
    const user = userEvent.setup();
    renderPill({ onClose });

    // When: clicking the close control
    await user.click(screen.getByRole('button', { name: 'Close' }));

    // Then: the handler fires
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('agent attention chip (design 1b)', () => {
    it('renders no chip when no workspace needs you and none are active', () => {
      // When: both counts are zero
      renderPill({ needsYouCount: 0, activeCount: 0 });

      // Then: no attention chip renders
      expect(screen.queryByText(/need|working/)).not.toBeInTheDocument();
    });

    it('marks the pill with the attention notice and shows the needsYou count', () => {
      // Given: one workspace needs the human
      const { container } = renderPill({ needsYouCount: 1, activeCount: 0 });

      // Then: the whole pill carries the attention notice (reusing the sync
      // pulse machinery) and the chip shows the count
      expect(container.querySelector('.morph-pill-bar')).toHaveAttribute(
        'data-notice',
        'attention'
      );
      expect(
        screen.getByLabelText('1 workspace needs you — open Mission Control')
      ).toBeInTheDocument();
    });

    it('prefers the attention notice over a plain sync notice when both apply', () => {
      // Given: the workspace is behind the remote AND an agent needs you
      const signals: ActionSignals = { ...QUIET, syncNeeded: true };

      // When: rendering the pill
      const { container } = renderPill({ signals, needsYouCount: 1 });

      // Then: attention wins the notice attribute
      expect(container.querySelector('.morph-pill-bar')).toHaveAttribute(
        'data-notice',
        'attention'
      );
    });

    it('shows the quiet play chip with the active count when nothing needs you', () => {
      // Given: agents working, nothing needs the human
      const { container } = renderPill({ needsYouCount: 0, activeCount: 2 });

      // Then: the play chip shows and the pill carries no notice
      expect(screen.getByLabelText('2 agents working, none need you')).toBeInTheDocument();
      expect(container.querySelector('.morph-pill-bar')).not.toHaveAttribute('data-notice');
    });

    it('opens Mission Control when the chip is clicked, without expanding the pill', async () => {
      // Given: a pill with a needs-you chip
      const user = userEvent.setup();
      const onOpenMissionControl = jest.fn();
      const outerClick = jest.fn();
      renderWithMantine(
        <div onClick={outerClick}>
          <Pill {...baseProps({ needsYouCount: 1, onOpenMissionControl })} />
        </div>
      );

      // When: clicking the chip
      await user.click(screen.getByLabelText('1 workspace needs you — open Mission Control'));

      // Then: Mission Control opens and the click never reaches the ancestor
      // (mirrors the close control's stopPropagation so the pill doesn't
      // also start a drag or expand)
      expect(onOpenMissionControl).toHaveBeenCalledTimes(1);
      expect(outerClick).not.toHaveBeenCalled();
    });
  });
});
