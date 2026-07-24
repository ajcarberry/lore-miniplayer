import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconChevronDown, IconPlus, IconRefresh } from '@tabler/icons-react';
import type { Repository, Workspace, WorkspaceBand, WorkspaceCard } from '../../../shared/types';
import { pluralize } from '../../utils/pluralize';
import { SectionLabel } from '../SectionLabel';
import { TitleBar } from '../TitleBar';
import { MissionCard } from './MissionCard';
import { IdleWorkspaceRow } from './IdleWorkspaceRow';
import { TeardownConfirmModal } from './TeardownConfirmModal';
import { ProvisionModal } from './ProvisionModal';
import { deriveWorkspaceFlags, groupRepositoriesByRepo, selectedRepositoryGroup } from './format';
import type { OpenReviewIntent } from './reviewIntent';

export interface MissionControlViewProps {
  readonly repositories: Repository[];
  readonly selectedRepositoryId: string | null;
  readonly baseBranch: string;
  readonly cards: WorkspaceCard[];
  readonly onSelectRepository: (repositoryId: string) => void;
  readonly onOpenTerminal: (path: string) => void;
  readonly onReview: (intent: OpenReviewIntent) => void;
  readonly onMarkActive: (workspaceId: string) => void;
  // Untrack-only removal (design amendment) — the non-destructive counterpart
  // to onTeardown; no confirmation modal (nothing is destroyed).
  readonly onForget: (workspaceId: string) => void;
  // Both resolve when the operation settles; the view drives its own busy state
  // and closes the modal on success.
  readonly onTeardown: (workspaceId: string, force: boolean) => Promise<void>;
  readonly onProvision: (branchName: string) => Promise<void>;
  // Manual refresh (header control), alongside the automatic triggers
  // (agent pushes, notifications, lifecycle events, 30s cadence). Resolves
  // when the invoke settles; the view drives its own brief loading state.
  readonly onRefresh: () => Promise<void>;
}

const BAND_LABEL: Record<WorkspaceBand, string> = {
  awaitingReview: 'Awaiting review',
  inProgress: 'In progress',
  idle: 'Idle',
};

const BAND_ORDER: readonly WorkspaceBand[] = ['awaitingReview', 'inProgress', 'idle'];

interface TeardownTarget {
  readonly workspace: Workspace;
  readonly requiresForce: boolean;
  readonly isRepoCheckout: boolean;
}

// The shared busy-flag shape around the async view actions: raise the flag,
// run, apply the success step, swallow the failure (the container surfaces
// it), always clear the flag.
function runWithBusy(
  setBusy: (busy: boolean) => void,
  run: Promise<void>,
  onSuccess?: () => void
): void {
  setBusy(true);
  void run
    .then(() => onSuccess?.())
    .catch(() => undefined)
    .finally(() => setBusy(false));
}

// The Mission Control surface (design 2a), scoped to the selected repository:
// header with repo switcher + provision entry, then the three bands. Purely
// presentational — all side effects arrive as props so it is unit-testable.
export function MissionControlView(props: MissionControlViewProps): ReactElement {
  const { repositories, selectedRepositoryId, baseBranch, cards } = props;
  const selectedRepository = repositories.find(repo => repo.id === selectedRepositoryId) ?? null;
  // The switcher lists repos, not workspace registry entries — same-repo
  // attached siblings (e.g. "adfa" alongside "demo-project") collapse into
  // one option (see groupRepositoriesByRepo).
  const repoGroups = groupRepositoriesByRepo(repositories);
  const selectedRepoGroup = selectedRepositoryGroup(repoGroups, selectedRepositoryId);

  const [teardownTarget, setTeardownTarget] = useState<TeardownTarget | null>(null);
  const [isTearingDown, setIsTearingDown] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const byBand = (band: WorkspaceBand): WorkspaceCard[] =>
    cards.filter(card => card.attention.band === band);

  const handleTeardownCard = (card: WorkspaceCard): void => {
    const flags = deriveWorkspaceFlags(card);
    setTeardownTarget({
      workspace: card.workspace,
      requiresForce: flags.requiresForce,
      isRepoCheckout: flags.isRepoCheckout,
    });
  };

  const handleConfirmTeardown = (force: boolean): void => {
    if (!teardownTarget) {
      return;
    }
    // On failure the modal stays open to retry.
    runWithBusy(
      setIsTearingDown,
      props.onTeardown(teardownTarget.workspace.instanceId, force),
      () => setTeardownTarget(null)
    );
  };

  const handleProvision = (branchName: string): void => {
    runWithBusy(setIsProvisioning, props.onProvision(branchName), () => setProvisionOpen(false));
  };

  const handleRefresh = (): void => {
    runWithBusy(setIsRefreshing, props.onRefresh());
  };

  return (
    <Stack gap={0} h='100vh' style={{ background: 'var(--paper)' }}>
      <TitleBar titleSuffix='Mission Control' />
      <Group px='md' pt='md' pb={4} gap='sm' align='flex-end'>
        <Menu position='bottom-start' withinPortal shadow='md'>
          <Menu.Target>
            <UnstyledButton aria-label='Switch repository'>
              <Group gap={4}>
                <SectionLabel c='var(--acc-deep)' letterSpacing='0.14em'>
                  {selectedRepoGroup?.name ?? 'No repository'}
                </SectionLabel>
                <IconChevronDown size={12} />
              </Group>
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            <ScrollArea.Autosize mah={240}>
              {repoGroups.map(group => (
                <Menu.Item
                  key={group.key}
                  onClick={() => props.onSelectRepository(group.representativeId)}
                >
                  {group.name}
                </Menu.Item>
              ))}
            </ScrollArea.Autosize>
          </Menu.Dropdown>
        </Menu>
        <Text size='xs' c='dimmed' ff='var(--font-mono)'>
          {`${cards.length} ${pluralize(cards.length, 'workspace')}`}
        </Text>
        <Tooltip label='Refresh workspaces'>
          <ActionIcon
            variant='subtle'
            size='sm'
            aria-label='Refresh workspaces'
            loading={isRefreshing}
            onClick={handleRefresh}
          >
            <IconRefresh size={14} />
          </ActionIcon>
        </Tooltip>
        <Button
          ml='auto'
          size='xs'
          radius='xl'
          leftSection={<IconPlus size={14} />}
          onClick={() => setProvisionOpen(true)}
          disabled={selectedRepository === null}
        >
          Provision workspace
        </Button>
      </Group>

      <ScrollArea style={{ flex: 1 }}>
        <Stack px='md' py='md' gap='md'>
          {cards.length === 0 ? (
            <Text size='sm' c='dimmed' ta='center' py='xl'>
              No workspaces in this repository yet.
            </Text>
          ) : (
            BAND_ORDER.map(band => {
              const bandCards = byBand(band);
              if (bandCards.length === 0) {
                return null;
              }
              return (
                <Stack key={band} gap='sm'>
                  <SectionLabel letterSpacing='0.14em'>
                    {`${BAND_LABEL[band]} · ${bandCards.length}`}
                  </SectionLabel>
                  {band === 'idle'
                    ? bandCards.map(card => (
                        <IdleWorkspaceRow
                          key={card.workspace.instanceId}
                          workspace={card.workspace}
                          isActive={card.isActive}
                          onOpenTerminal={props.onOpenTerminal}
                          onMarkActive={workspace => props.onMarkActive(workspace.instanceId)}
                          onTeardown={() => handleTeardownCard(card)}
                          onForget={workspace => props.onForget(workspace.instanceId)}
                        />
                      ))
                    : bandCards.map(card => (
                        <MissionCard
                          key={card.workspace.instanceId}
                          card={card}
                          onOpenTerminal={props.onOpenTerminal}
                          onReview={props.onReview}
                          onTeardown={handleTeardownCard}
                          onForget={forgetCard => props.onForget(forgetCard.workspace.instanceId)}
                        />
                      ))}
                </Stack>
              );
            })
          )}
        </Stack>
      </ScrollArea>

      <TeardownConfirmModal
        key={teardownTarget?.workspace.instanceId ?? 'none'}
        opened={teardownTarget !== null}
        workspace={teardownTarget?.workspace ?? null}
        requiresForce={teardownTarget?.requiresForce ?? false}
        isRepoCheckout={teardownTarget?.isRepoCheckout ?? false}
        isTearingDown={isTearingDown}
        onClose={() => setTeardownTarget(null)}
        onConfirm={handleConfirmTeardown}
      />
      <ProvisionModal
        key={provisionOpen ? 'open' : 'closed'}
        opened={provisionOpen}
        repository={selectedRepository}
        baseBranch={baseBranch}
        isProvisioning={isProvisioning}
        onClose={() => setProvisionOpen(false)}
        onSubmit={handleProvision}
      />
    </Stack>
  );
}
