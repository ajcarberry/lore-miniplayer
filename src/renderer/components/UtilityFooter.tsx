import type { ReactElement } from 'react';
import { useCallback } from 'react';
import {
  ActionIcon,
  Group,
  Menu,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconCheck,
  IconDeviceDesktop,
  IconEdit,
  IconFolderOpen,
  IconFolders,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconServer,
  IconSun,
  IconTarget,
  IconTerminal2,
} from '@tabler/icons-react';
import type { Repository, ThemeMode } from '../../shared/types';
import { loreAccent } from '../../shared/accent';
import { useThemeMode } from '../hooks/useThemeMode';
import { logError } from '../utils/logging';
import { groupWorkspacesByRepo, workspaceDisplayName } from '../utils/repository-name';
import classes from './UtilityFooter.module.css';

interface UtilityFooterProps {
  readonly selectedRepo: Repository | null;
  readonly repositories: Repository[];
  readonly isLoadingRepos: boolean;
  readonly onSelectRepo: (repo: Repository) => void;
  readonly onAddRepo: () => void;
  readonly onEditRepo: (repo: Repository) => void;
  readonly onRefreshRepos: () => void;
  readonly serverUrl: string | null;
  readonly onChangeServer: () => void;
  // Sixth footer icon (design 1c): opens Mission Control for the selected
  // repository.
  readonly onOpenMissionControl: () => void;
}

const THEME_OPTIONS: ReadonlyArray<{
  readonly mode: ThemeMode;
  readonly label: string;
  readonly icon: ReactElement;
}> = [
  { mode: 'auto', label: 'Auto', icon: <IconDeviceDesktop size={14} /> },
  { mode: 'light', label: 'Light', icon: <IconSun size={14} /> },
  { mode: 'dark', label: 'Dark', icon: <IconMoon size={14} /> },
];

function themeModeIcon(mode: ThemeMode): ReactElement {
  if (mode === 'light') {
    return <IconSun size={18} stroke={1.5} />;
  }
  if (mode === 'dark') {
    return <IconMoon size={18} stroke={1.5} />;
  }
  return <IconDeviceDesktop size={18} stroke={1.5} />;
}

interface RepositoryRowProps {
  readonly repo: Repository;
  readonly isSelected: boolean;
  readonly onSelect: (repo: Repository) => void;
  readonly onEdit: (repo: Repository) => void;
}

function RepositoryRow({ repo, isSelected, onSelect, onEdit }: RepositoryRowProps): ReactElement {
  return (
    <Group
      justify='space-between'
      wrap='nowrap'
      gap={4}
      pl={16}
      pr={4}
      py={4}
      className={classes.repoRow}
      data-active={isSelected ? 'true' : undefined}
    >
      <UnstyledButton onClick={() => onSelect(repo)} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap='nowrap'>
          <span
            className={classes.accentDot}
            style={{ backgroundColor: loreAccent(repo.accentHue).base }}
          />
          <Text size='sm' truncate>
            {workspaceDisplayName(repo)}
          </Text>
        </Group>
      </UnstyledButton>
      <ActionIcon
        size='xs'
        variant='subtle'
        aria-label={`Edit ${repo.name}`}
        onClick={() => onEdit(repo)}
      >
        <IconEdit size={12} />
      </ActionIcon>
    </Group>
  );
}

// The card's bottom utility strip: file explorer / terminal shortcuts for
// the selected repository, a workspace picker menu (select, add, edit,
// refresh — every unified-registry entry, provisioned worktrees included —
// grouped per repo via `groupWorkspacesByRepo`, one `Menu.Label` per group
// so a workspace's own row never has to repeat its repo's name), a server
// popover for the disconnect flow, and the theme mode menu. Rendered only
// in the connected view.
export function UtilityFooter({
  selectedRepo,
  repositories,
  isLoadingRepos,
  onSelectRepo,
  onAddRepo,
  onEditRepo,
  onRefreshRepos,
  serverUrl,
  onChangeServer,
  onOpenMissionControl,
}: UtilityFooterProps): ReactElement {
  const { themeMode, setThemeMode } = useThemeMode();

  const openInExplorer = useCallback(async (): Promise<void> => {
    if (!selectedRepo) {
      return;
    }
    const result = await window.electronAPI.repository.openInExplorer(selectedRepo.localPath);
    if (!result.success) {
      logError('Failed to open in explorer', {
        error: result.error,
        localPath: selectedRepo.localPath,
        operation: 'UtilityFooter',
      });
    }
  }, [selectedRepo]);

  const openTerminal = useCallback(async (): Promise<void> => {
    if (!selectedRepo) {
      return;
    }
    const result = await window.electronAPI.window.openTerminal(selectedRepo.localPath);
    if (!result.success) {
      logError('Failed to open terminal', {
        error: result.error,
        localPath: selectedRepo.localPath,
        operation: 'UtilityFooter',
      });
    }
  }, [selectedRepo]);

  return (
    <Group justify='center' gap={4} py={6} className={classes.footer}>
      <Tooltip label='Open in File Explorer'>
        <ActionIcon
          variant='subtle'
          size='lg'
          className={classes.icon}
          aria-label='Open in File Explorer'
          data-disabled={!selectedRepo}
          onClick={
            !selectedRepo ? (e): void => e.preventDefault() : (): void => void openInExplorer()
          }
        >
          <IconFolderOpen size={18} stroke={1.5} />
        </ActionIcon>
      </Tooltip>

      <Tooltip label='Open Terminal here'>
        <ActionIcon
          variant='subtle'
          size='lg'
          className={classes.icon}
          aria-label='Open Terminal here'
          data-disabled={!selectedRepo}
          onClick={
            !selectedRepo ? (e): void => e.preventDefault() : (): void => void openTerminal()
          }
        >
          <IconTerminal2 size={18} stroke={1.5} />
        </ActionIcon>
      </Tooltip>

      <Tooltip label='Mission Control'>
        <ActionIcon
          variant='subtle'
          size='lg'
          className={classes.icon}
          aria-label='Mission Control'
          data-disabled={!selectedRepo}
          onClick={!selectedRepo ? (e): void => e.preventDefault() : onOpenMissionControl}
        >
          <IconTarget size={18} stroke={1.5} />
        </ActionIcon>
      </Tooltip>

      <Menu position='top' withinPortal shadow='md' width={240}>
        <Tooltip label='Workspaces'>
          <Menu.Target>
            <ActionIcon variant='subtle' size='lg' className={classes.icon} aria-label='Workspaces'>
              <IconFolders size={18} stroke={1.5} />
            </ActionIcon>
          </Menu.Target>
        </Tooltip>
        <Menu.Dropdown p={4}>
          <Stack gap={2}>
            <ScrollArea.Autosize mah={200}>
              <Stack gap={2}>
                {groupWorkspacesByRepo(repositories).map(group => (
                  <Stack key={group.key} gap={2}>
                    <Menu.Label>{group.repoName}</Menu.Label>
                    {group.workspaces.map(repo => (
                      <RepositoryRow
                        key={repo.id}
                        repo={repo}
                        isSelected={repo.id === selectedRepo?.id}
                        onSelect={onSelectRepo}
                        onEdit={onEditRepo}
                      />
                    ))}
                  </Stack>
                ))}
              </Stack>
            </ScrollArea.Autosize>
            <UnstyledButton onClick={onAddRepo} p={4}>
              <Group gap={6}>
                <IconPlus size={14} />
                <Text size='sm'>Add workspace…</Text>
              </Group>
            </UnstyledButton>
            <UnstyledButton onClick={onRefreshRepos} disabled={isLoadingRepos} p={4}>
              <Group gap={6}>
                <IconRefresh size={14} />
                <Text size='sm'>Refresh</Text>
              </Group>
            </UnstyledButton>
          </Stack>
        </Menu.Dropdown>
      </Menu>

      <Popover position='top' withinPortal shadow='md'>
        <Tooltip label='Server'>
          <Popover.Target>
            <ActionIcon variant='subtle' size='lg' className={classes.icon} aria-label='Server'>
              <IconServer size={18} stroke={1.5} />
            </ActionIcon>
          </Popover.Target>
        </Tooltip>
        <Popover.Dropdown p='sm'>
          <Stack gap='xs'>
            <Text ff='var(--font-mono)' size='xs' c='dimmed'>
              {serverUrl ?? '—'}
            </Text>
            <UnstyledButton onClick={onChangeServer}>
              <Text size='sm'>Change server…</Text>
            </UnstyledButton>
          </Stack>
        </Popover.Dropdown>
      </Popover>

      <Menu position='top' withinPortal shadow='md'>
        <Tooltip label={`Theme: ${themeMode}`}>
          <Menu.Target>
            <ActionIcon variant='subtle' size='lg' className={classes.icon} aria-label='Theme'>
              {themeModeIcon(themeMode)}
            </ActionIcon>
          </Menu.Target>
        </Tooltip>
        <Menu.Dropdown>
          {THEME_OPTIONS.map(option => (
            <Menu.Item
              key={option.mode}
              leftSection={option.icon}
              rightSection={themeMode === option.mode ? <IconCheck size={14} /> : undefined}
              onClick={() => void setThemeMode(option.mode)}
            >
              {option.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
