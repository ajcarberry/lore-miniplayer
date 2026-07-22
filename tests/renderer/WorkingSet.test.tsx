import type { ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkingSet } from '../../src/renderer/components/WorkingSet';
import type { WorkingSetFile, WorkingSetProps } from '../../src/renderer/components/WorkingSet';

const files: WorkingSetFile[] = [
  { path: 'src/deep/nested/dir/changed.ts', kind: 'edit', staged: true },
  { path: 'new-file.txt', kind: 'add', staged: false },
];

function baseProps(overrides: Partial<WorkingSetProps> = {}): WorkingSetProps {
  return {
    files: [],
    open: false,
    onToggleOpen: jest.fn(),
    onToggleFile: jest.fn(),
    isLoading: false,
    ...overrides,
  };
}

function renderWorkingSet(props: WorkingSetProps): void {
  render((<MantineProvider>{<WorkingSet {...props} />}</MantineProvider>) as ReactElement);
}

describe('WorkingSet', () => {
  it('shows a "clean" meta and hides the list when there are no files', () => {
    // When: rendering with no files, open
    renderWorkingSet(baseProps({ files: [], open: true }));

    // Then: the clean meta is shown and no file rows render
    expect(screen.getByText('clean')).toBeInTheDocument();
    expect(screen.queryByText('changed.ts')).not.toBeInTheDocument();
  });

  it('shows the staged/changed meta counts when files are present', () => {
    // When: rendering with a mix of staged/unstaged files
    renderWorkingSet(baseProps({ files, open: true }));

    // Then: the meta summarizes staged vs total changed
    expect(screen.getByText('1 staged · 2 changed')).toBeInTheDocument();
  });

  it('shows a loading indicator instead of the list while loading', () => {
    // When: rendering open + loading
    renderWorkingSet(baseProps({ open: true, isLoading: true }));

    // Then: a status/loading affordance is shown, no clean/file text
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('calls onToggleOpen when the header is clicked', async () => {
    // Given: a rendered working set
    const user = userEvent.setup();
    const onToggleOpen = jest.fn();
    renderWorkingSet(baseProps({ files, onToggleOpen }));

    // When: clicking the header
    await user.click(screen.getByText('Working Set'));

    // Then: the toggle callback fires
    expect(onToggleOpen).toHaveBeenCalledTimes(1);
  });

  it('does not render file rows when closed', () => {
    // When: rendering closed with files present
    renderWorkingSet(baseProps({ files, open: false }));

    // Then: no file rows are shown
    expect(screen.queryByText('changed.ts')).not.toBeInTheDocument();
  });

  it('renders each file with its kind letter and filename, truncating the directory', () => {
    // When: rendering open with files
    renderWorkingSet(baseProps({ files, open: true }));

    // Then: kind letters and filenames are shown
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('changed.ts')).toBeInTheDocument();
    expect(screen.getByText('new-file.txt')).toBeInTheDocument();
  });

  it('reflects staged state on each row checkbox', () => {
    // When: rendering open with a staged and an unstaged file
    renderWorkingSet(baseProps({ files, open: true }));

    // Then: checkboxes reflect the staged flags
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it('calls onToggleFile with the file path when a row is clicked', async () => {
    // Given: a rendered, open working set
    const user = userEvent.setup();
    const onToggleFile = jest.fn();
    renderWorkingSet(baseProps({ files, open: true, onToggleFile }));

    // When: clicking a file row's text
    await user.click(screen.getByText('new-file.txt'));

    // Then: the toggle callback fires with that file's path exactly once
    expect(onToggleFile).toHaveBeenCalledTimes(1);
    expect(onToggleFile).toHaveBeenCalledWith('new-file.txt');
  });

  it('calls onToggleFile exactly once when the row checkbox itself is clicked', async () => {
    // Given: a rendered, open working set
    const user = userEvent.setup();
    const onToggleFile = jest.fn();
    renderWorkingSet(baseProps({ files, open: true, onToggleFile }));

    // When: clicking the checkbox for the staged file
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]!);

    // Then: the toggle callback fires exactly once with that file's path
    expect(onToggleFile).toHaveBeenCalledTimes(1);
    expect(onToggleFile).toHaveBeenCalledWith('src/deep/nested/dir/changed.ts');
  });

  describe('directory prefix formatting (bug 2 — start-truncated bidi reorder)', () => {
    // Mantine's truncate='start' sets CSS `direction: rtl` on the dir span
    // (styles.css: `[data-truncate='start'] { direction: rtl; text-align:
    // end; }`) so a long prefix can ellipsize from the front while the
    // filename stays fully visible. Verified in a real Chromium render: a
    // bare trailing "/" is a bidi-neutral character, and inside that RTL
    // run the Unicode Bidi Algorithm (rule L2) reorders it to the FRONT of
    // the run — "Config/" paints as "/Config", "Docs/Features/" as
    // "/Docs/Features" — exactly the live "leading slash, dropped last
    // separator" symptom. The fix pins the slash as strong-LTR with a
    // trailing Left-to-Right Mark (U+200E) so the reorder cancels out.
    it.each([
      ['Config/DefaultEngine.ini', 'Config/'],
      ['Docs/Features/GlowcapSporeBloom.md', 'Docs/Features/'],
      ['src/deep/nested/dir/changed.ts', 'src/deep/nested/dir/'],
    ])('appends a trailing LRM after the directory slash for %s', (path, expectedDir) => {
      // When: rendering a row for a path with a directory prefix
      renderWorkingSet(baseProps({ files: [{ path, kind: 'edit', staged: false }], open: true }));

      // Then: the dir text node carries the visible prefix plus an
      // invisible LRM right after the slash
      expect(screen.getByText(`${expectedDir}\u200E`)).toBeInTheDocument();
    });

    it('renders a root-level file with no directory prefix and no leading slash', () => {
      // When: rendering a file with no directory component
      renderWorkingSet(
        baseProps({ files: [{ path: 'new-file.txt', kind: 'add', staged: false }], open: true })
      );

      // Then: only the filename renders — no dir text, no leading slash
      expect(screen.getByText('new-file.txt')).toBeInTheDocument();
      expect(screen.queryByText(/^\//)).not.toBeInTheDocument();
    });
  });

  describe('conflict rows (design 1c)', () => {
    const conflictedFiles: WorkingSetFile[] = [
      {
        path: 'levels/act2/encounters.toml',
        kind: 'edit',
        staged: false,
        conflictUnresolved: true,
      },
      { path: 'levels/act2/pacing.toml', kind: 'edit', staged: false },
    ];

    it('replaces the checkbox with a warning glyph on an unresolved conflict row', () => {
      // When: rendering a working set with one conflicted, one clean file
      renderWorkingSet(
        baseProps({ files: conflictedFiles, open: true, conflictRevisionNumber: 128 })
      );

      // Then: the conflicted row has no checkbox (staging is blocked); the
      // clean row keeps its checkbox
      expect(screen.getAllByRole('checkbox')).toHaveLength(1);
      expect(screen.getByLabelText('Conflicted — cannot stage until resolved')).toBeInTheDocument();
    });

    it('shows "conflicts with rN" using the supplied conflict revision number', () => {
      // When: rendering with a known conflict revision
      renderWorkingSet(
        baseProps({ files: conflictedFiles, open: true, conflictRevisionNumber: 128 })
      );

      // Then: the row names the revision it conflicts with
      expect(screen.getByText('conflicts with r128')).toBeInTheDocument();
    });

    it('falls back to a bare "conflicts" label when no revision number is known', () => {
      // When: rendering without a conflict revision number (branch graph
      // hasn't resolved a tip yet)
      renderWorkingSet(baseProps({ files: conflictedFiles, open: true }));

      // Then: the row still flags the conflict, without a fabricated number
      expect(screen.getByText('conflicts')).toBeInTheDocument();
      expect(screen.queryByText(/conflicts with r/)).not.toBeInTheDocument();
    });

    it('does not call onToggleFile when a conflicted row is clicked', async () => {
      // Given: a rendered working set with a conflicted row
      const user = userEvent.setup();
      const onToggleFile = jest.fn();
      renderWorkingSet(
        baseProps({ files: conflictedFiles, open: true, onToggleFile, conflictRevisionNumber: 128 })
      );

      // When: clicking the conflicted row's filename
      await user.click(screen.getByText('encounters.toml'));

      // Then: staging is blocked — the toggle callback never fires
      expect(onToggleFile).not.toHaveBeenCalled();
    });

    it('still stages the clean row alongside a conflicted one', async () => {
      // Given: a rendered working set with one conflicted, one clean file
      const user = userEvent.setup();
      const onToggleFile = jest.fn();
      renderWorkingSet(
        baseProps({ files: conflictedFiles, open: true, onToggleFile, conflictRevisionNumber: 128 })
      );

      // When: clicking the clean row's filename
      await user.click(screen.getByText('pacing.toml'));

      // Then: the clean row still toggles normally
      expect(onToggleFile).toHaveBeenCalledWith('levels/act2/pacing.toml');
    });
  });
});
