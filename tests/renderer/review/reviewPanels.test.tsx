import type { ReactElement, ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RightPanel } from '../../../src/renderer/components/review/RightPanel';
import { ComparePicker } from '../../../src/renderer/components/review/ComparePicker';
import { FileList } from '../../../src/renderer/components/review/FileList';
import type { ReviewFile } from '../../../src/renderer/components/review/reviewModel';
import type { ReviewCompare, RevisionSummary } from '../../../src/shared/types';

function makeFile(overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path: 'a.toml',
    action: 'modified',
    lineStats: { added: 1, removed: 0 },
    binary: false,
    truncated: false,
    patch: '',
    staged: false,
    conflictUnresolved: false,
    ...overrides,
  };
}

function renderWithMantine(ui: ReactNode): void {
  render((<MantineProvider>{ui}</MantineProvider>) as ReactElement);
}

describe('RightPanel', () => {
  it('renders the intention placeholder when no content is provided (P12 slot)', () => {
    renderWithMantine(<RightPanel />);
    expect(screen.getByText(/appears here beside the diff/)).toBeInTheDocument();
  });

  it('renders provided intention content and the session footer slot', () => {
    renderWithMantine(<RightPanel session={<span>session 9f2c · $1.62</span>}>Asked</RightPanel>);
    expect(screen.getByText('Asked')).toBeInTheDocument();
    expect(screen.getByText('session 9f2c · $1.62')).toBeInTheDocument();
  });
});

describe('FileList', () => {
  it('renders an empty stats label for a non-binary file that has no line stats', () => {
    renderWithMantine(
      <FileList
        files={[makeFile({ path: 'moved.toml', action: 'moved', lineStats: undefined })]}
        selectedPath={null}
        onSelect={jest.fn()}
        onToggleStage={jest.fn()}
      />
    );
    // Deleted/moved badge letter renders; the stats cell is empty (no "binary").
    expect(screen.getByText('R')).toBeInTheDocument();
    expect(screen.queryByText('binary')).not.toBeInTheDocument();
  });

  it('singularises the header for a single file', () => {
    renderWithMantine(
      <FileList
        files={[makeFile()]}
        selectedPath='a.toml'
        onSelect={jest.fn()}
        onToggleStage={jest.fn()}
      />
    );
    expect(screen.getByText(/1 file · \+1 −0 · stage for commit/)).toBeInTheDocument();
  });
});

describe('ComparePicker', () => {
  const compare: ReviewCompare = {
    source: { kind: 'revision', revision: 'r128' },
    target: { kind: 'workingTree' },
  };
  const revisions: RevisionSummary[] = [
    { revision: 'r130', revisionNumber: 130, message: 'Flatten pacing' },
    { revision: 'r129', revisionNumber: 129 },
  ];

  it('picks a revision target (and shows a bare revision with no message)', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    renderWithMantine(
      <ComparePicker compare={compare} revisions={revisions} onChange={onChange} />
    );

    await user.click(screen.getByLabelText('Change compare target'));
    // The bare revision (no message) renders just its hash.
    await user.click(await screen.findByText('r129'));

    expect(onChange).toHaveBeenCalledWith({
      source: compare.source,
      target: { kind: 'revision', revision: 'r129' },
    });
  });

  it('picks the working tree as the target', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    renderWithMantine(
      <ComparePicker
        compare={{ source: compare.source, target: { kind: 'revision', revision: 'r130' } }}
        revisions={revisions}
        onChange={onChange}
      />
    );

    await user.click(screen.getByLabelText('Change compare target'));
    await user.click(await screen.findByText('working tree'));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'workingTree' } })
    );
  });
});
