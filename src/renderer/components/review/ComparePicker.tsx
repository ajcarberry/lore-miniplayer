import type { ReactElement } from 'react';
import { Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { CompareTarget, ReviewCompare, RevisionSummary } from '../../../shared/types';
import { compareTargetLabel } from './reviewModel';

export interface ComparePickerProps {
  readonly compare: ReviewCompare;
  // Branch revisions (newest first) offered as compare endpoints, from the
  // branch history hooks.
  readonly revisions: readonly RevisionSummary[];
  readonly onChange: (next: ReviewCompare) => void;
}

interface EndpointProps {
  readonly label: string;
  readonly ariaLabel: string;
  readonly revisions: readonly RevisionSummary[];
  readonly includeWorkingTree: boolean;
  readonly onPick: (target: CompareTarget) => void;
}

// One dashed-underline endpoint that opens a menu of revisions (and, for the
// target, the working tree).
function Endpoint(props: EndpointProps): ReactElement {
  return (
    <Menu position='bottom-start' withinPortal shadow='md'>
      <Menu.Target>
        <UnstyledButton aria-label={props.ariaLabel}>
          <Group gap={3}>
            <Text
              size='xs'
              ff='var(--font-mono)'
              style={{ borderBottom: '1px dashed var(--ink-30, rgba(43,36,22,.3))' }}
            >
              {props.label}
            </Text>
            <IconChevronDown size={11} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {props.includeWorkingTree && (
          <Menu.Item onClick={() => props.onPick({ kind: 'workingTree' })}>working tree</Menu.Item>
        )}
        {props.revisions.map(revision => (
          <Menu.Item
            key={revision.revision}
            onClick={() => props.onPick({ kind: 'revision', revision: revision.revision })}
          >
            {revision.message ? `${revision.revision} · ${revision.message}` : revision.revision}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

// The review window header's compare picker (design 2b: "compare r128 ▾ →
// working tree ▾"). Selecting either endpoint hands the full new compare to the
// container, which refetches the diff.
export function ComparePicker(props: ComparePickerProps): ReactElement {
  const { compare, revisions } = props;
  return (
    <Group
      gap={6}
      px={10}
      py={5}
      style={{
        border: '1px solid var(--hairline, rgba(43,36,22,.18))',
        borderRadius: 8,
        background: 'var(--paper-raised, #fbf7ec)',
      }}
    >
      <Text size='xs' c='dimmed'>
        compare
      </Text>
      <Endpoint
        label={compareTargetLabel(compare.source)}
        ariaLabel='Change compare source'
        revisions={revisions}
        includeWorkingTree={false}
        onPick={source => props.onChange({ ...compare, source })}
      />
      <Text size='xs' c='dimmed'>
        →
      </Text>
      <Endpoint
        label={compareTargetLabel(compare.target)}
        ariaLabel='Change compare target'
        revisions={revisions}
        includeWorkingTree
        onPick={target => props.onChange({ ...compare, target })}
      />
    </Group>
  );
}
