import type { ReactElement, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import {
  Box,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import type { LoreBranch } from '../../shared/types';

interface BranchSwitcherProps {
  readonly branches: LoreBranch[];
  readonly currentBranch: string;
  readonly isLoading: boolean;
  readonly onSelect: (branch: string) => void;
  readonly onReload: () => void;
  // Render prop: receives the toggle so the caller's header can drive
  // opening the popover (the header owns the clickable affordance).
  readonly children: (onOpenSwitcher: () => void) => ReactNode;
}

// Popover-anchored branch switcher: click the header to open, search/pick a
// branch from the list fed by useBranches. Picking a branch hands off to the
// existing switch-&-sync guard in useSyncActions unchanged.
export function BranchSwitcher({
  branches,
  currentBranch,
  isLoading,
  onSelect,
  onReload,
  children,
}: BranchSwitcherProps): ReactElement {
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState('');

  const handleChange = useCallback(
    (next: boolean): void => {
      setOpened(next);
      if (next) {
        onReload();
      } else {
        setSearch('');
      }
    },
    [onReload]
  );

  const handleOpenSwitcher = useCallback((): void => {
    handleChange(!opened);
  }, [handleChange, opened]);

  const handleSelect = useCallback(
    (branch: string): void => {
      onSelect(branch);
      handleChange(false);
    },
    [onSelect, handleChange]
  );

  const filtered = branches.filter(branch =>
    branch.name.toLowerCase().includes(search.toLowerCase().trim())
  );

  return (
    <Popover
      opened={opened}
      onChange={handleChange}
      position='bottom-start'
      width={260}
      withinPortal
      shadow='md'
    >
      <Popover.Target>
        <Box>{children(handleOpenSwitcher)}</Box>
      </Popover.Target>
      <Popover.Dropdown p={4}>
        <Stack gap={4}>
          <TextInput
            size='xs'
            placeholder='Search branches...'
            value={search}
            onChange={event => setSearch(event.currentTarget.value)}
          />
          <ScrollArea.Autosize mah={200}>
            <Stack gap={2}>
              {isLoading ? (
                <Text size='sm' c='dimmed' p='xs'>
                  Loading branches...
                </Text>
              ) : filtered.length === 0 ? (
                <Text size='sm' c='dimmed' p='xs'>
                  {branches.length === 0 ? 'No branches available' : 'No branches found'}
                </Text>
              ) : (
                filtered.map(branch => (
                  <UnstyledButton
                    key={branch.name}
                    p='xs'
                    onClick={() => handleSelect(branch.name)}
                  >
                    <Group justify='space-between' wrap='nowrap'>
                      <Text ff='var(--font-mono)' size='sm'>
                        {branch.name}
                      </Text>
                      {branch.name === currentBranch && (
                        <Text size='xs' c='dimmed'>
                          current
                        </Text>
                      )}
                    </Group>
                  </UnstyledButton>
                ))
              )}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
