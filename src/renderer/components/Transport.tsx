import type { ReactElement } from 'react';
import {
  ActionIcon,
  Box,
  Loader,
  Menu,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconChevronDown,
  IconDownload,
  IconGitCommit,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import classes from './Transport.module.css';

interface SyncMenuConfig {
  readonly onSyncToRevision: () => void;
  readonly onReset: () => void;
}

interface SyncConfig {
  readonly label: string;
  readonly sub: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly accented: boolean;
  readonly onClick: () => void;
  readonly menu: SyncMenuConfig;
}

interface CommitConfig {
  readonly count: number;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly accented: boolean;
  readonly onClick: () => void;
}

interface PushConfig {
  readonly sub: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly accented: boolean;
  readonly onClick: () => void;
}

interface CloneConfig {
  readonly busy: boolean;
  readonly onClick: () => void;
}

export interface TransportProps {
  readonly mode: 'clone' | 'normal';
  readonly sync: SyncConfig;
  readonly commit: CommitConfig;
  readonly push: PushConfig;
  readonly clone: CloneConfig;
}

interface TransportCellProps {
  readonly icon: ReactElement;
  readonly label: string;
  readonly sub: string;
  readonly busy?: boolean;
  readonly disabled: boolean;
  readonly primary?: boolean;
  readonly onClick: () => void;
}

// Icon-in-tile + bold label + small sub-caption (which carries any count —
// no separate badge). The sanctioned custom-CSS zone (Transport.module.css)
// supplies the tile look (tokens + hover lift) that Mantine's UnstyledButton
// doesn't provide.
function TransportCell({
  icon,
  label,
  sub,
  busy = false,
  disabled,
  primary = false,
  onClick,
}: TransportCellProps): ReactElement {
  return (
    <Box>
      <UnstyledButton
        className={classes.cell}
        data-primary={primary ? 'true' : undefined}
        disabled={disabled || busy}
        onClick={onClick}
      >
        <Stack gap={2} align='center'>
          {busy ? <Loader size={18} /> : icon}
          <Text fw={700} size='sm'>
            {label}
          </Text>
          <Text size='xs' {...(primary ? {} : { c: 'dimmed' as const })}>
            {sub}
          </Text>
        </Stack>
      </UnstyledButton>
    </Box>
  );
}

function SyncCell({ sync }: { readonly sync: SyncConfig }): ReactElement {
  const disabled = sync.disabled || sync.busy;
  return (
    <Box className={classes.syncCell} pos='relative'>
      <TransportCell
        icon={<IconRefresh size={20} />}
        label={sync.label}
        sub={sync.sub}
        busy={sync.busy}
        disabled={sync.disabled}
        primary={sync.accented}
        onClick={sync.onClick}
      />
      <Menu position='bottom-end' withArrow>
        <Menu.Target>
          <ActionIcon
            className={classes.chevron}
            size='sm'
            variant='subtle'
            disabled={disabled}
            aria-label='More sync options'
          >
            <IconChevronDown size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconGitCommit size={16} />} onClick={sync.menu.onSyncToRevision}>
            Sync to Revision…
          </Menu.Item>
          <Menu.Item leftSection={<IconTrash size={16} />} color='red' onClick={sync.menu.onReset}>
            Reset
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}

// The card's transport row: Sync (with a split menu for revision-sync/reset),
// Commit, and Push as the primary action. Staging happens per-file via the
// Working Set checkboxes, not from this row. When the repository isn't
// cloned to disk yet, the primary slot becomes Clone and Commit is
// force-disabled — there is nothing to commit before a clone.
export function Transport({ mode, sync, commit, push, clone }: TransportProps): ReactElement {
  const commitDisabled = mode === 'clone' || commit.disabled;

  return (
    <SimpleGrid cols={3} spacing='xs'>
      <SyncCell sync={sync} />
      <TransportCell
        icon={<IconGitCommit size={20} />}
        label='Commit'
        sub={commit.count > 0 ? `${commit.count} staged` : '—'}
        busy={commit.busy}
        disabled={commitDisabled}
        primary={commit.accented}
        onClick={commit.onClick}
      />
      {mode === 'clone' ? (
        <TransportCell
          icon={<IconDownload size={20} />}
          label='Clone'
          sub='Not on disk'
          busy={clone.busy}
          disabled={false}
          primary
          onClick={clone.onClick}
        />
      ) : (
        <TransportCell
          icon={<IconUpload size={20} />}
          label='Push'
          sub={push.sub}
          busy={push.busy}
          disabled={push.disabled}
          primary={push.accented}
          onClick={push.onClick}
        />
      )}
    </SimpleGrid>
  );
}
