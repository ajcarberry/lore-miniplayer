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

  it('renders no review or merge actions when no handlers are provided', () => {
    // When: rendering without review/merge handlers
    renderWorkingSet(baseProps({ files, open: true }));

    // Then: the header carries no review/merge affordances
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
  });

  it('opens the review workflow from the header without toggling the section', async () => {
    // Given: a working set with a review handler
    const user = userEvent.setup();
    const onReview = jest.fn();
    const onToggleOpen = jest.fn();
    renderWorkingSet(baseProps({ files, open: true, onToggleOpen, onReview }));

    // When: clicking the Review action in the header
    await user.click(screen.getByRole('button', { name: 'Review' }));

    // Then: the review handler fires and the header click does not collapse
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onToggleOpen).not.toHaveBeenCalled();
  });

  it('opens the merge workflow from the header without toggling the section', async () => {
    // Given: a working set with review and merge handlers
    const user = userEvent.setup();
    const onMerge = jest.fn();
    const onToggleOpen = jest.fn();
    renderWorkingSet(baseProps({ files, open: true, onToggleOpen, onReview: jest.fn(), onMerge }));

    // When: clicking the Merge action in the header
    await user.click(screen.getByRole('button', { name: 'Merge' }));

    // Then: the merge handler fires and the header click does not collapse
    expect(onMerge).toHaveBeenCalledTimes(1);
    expect(onToggleOpen).not.toHaveBeenCalled();
  });
});
