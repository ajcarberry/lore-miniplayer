import type { ReactElement } from 'react';
import { useCallback } from 'react';
import { notifications } from '@mantine/notifications';
import { useRepositories } from '../../hooks/useRepositories';
import { useBranches } from '../../hooks/useBranches';
import { useMissionControlSnapshot } from '../../hooks/useMissionControlSnapshot';
import { MissionControlView } from './MissionControlView';
import { requestOpenReviewWindow } from './reviewIntent';

// Mission Control container: loads the repositories, the selected repo's
// current branch (the provision base), and the live workspace snapshot, then
// wires the view's side effects to the workspace/window IPC. The window is
// always "connected" — it only opens over a live repository set.
export function MissionControl(): ReactElement {
  const { repositories, selectedRepo, selectRepository } = useRepositories(true);
  const { currentBranch } = useBranches(selectedRepo, true);
  const cards = useMissionControlSnapshot(selectedRepo?.id ?? null);

  const handleSelectRepository = useCallback(
    (repositoryId: string): void => {
      selectRepository(repositories.find(repo => repo.id === repositoryId) ?? null);
    },
    [repositories, selectRepository]
  );

  const handleOpenTerminal = useCallback((path: string): void => {
    void window.electronAPI.window.openTerminal(path).then(result => {
      if (!result.success) {
        notifications.show({ color: 'red', title: 'Open terminal failed', message: result.error });
      }
    });
  }, []);

  const handleMarkActive = useCallback((workspaceId: string): void => {
    void window.electronAPI.workspace.markActive({ workspaceId }).then(result => {
      if (!result.success) {
        notifications.show({ color: 'red', title: 'Mark active failed', message: result.error });
      }
    });
  }, []);

  const handleForget = useCallback((workspaceId: string): void => {
    void window.electronAPI.workspace.forget({ workspaceId }).then(result => {
      if (!result.success) {
        notifications.show({
          color: 'red',
          title: 'Forget workspace failed',
          message: result.error,
        });
      }
    });
  }, []);

  const handleTeardown = useCallback(async (workspaceId: string, force: boolean): Promise<void> => {
    const result = await window.electronAPI.workspace.teardown({ workspaceId, force });
    if (!result.success) {
      notifications.show({ color: 'red', title: 'Close workspace failed', message: result.error });
      throw new Error(result.error);
    }
  }, []);

  const handleProvision = useCallback(
    async (branchName: string): Promise<void> => {
      if (!selectedRepo) {
        return;
      }
      const result = await window.electronAPI.workspace.provision({
        repositoryId: selectedRepo.id,
        branchName,
      });
      if (!result.success) {
        notifications.show({ color: 'red', title: 'Provision failed', message: result.error });
        throw new Error(result.error);
      }
    },
    [selectedRepo]
  );

  // Manual refresh (header control), alongside the automatic triggers (agent
  // pushes, notifications, workspace lifecycle events, 30s cadence). The
  // rebuilt snapshot arrives via the existing onSnapshot push, not this call's
  // own response.
  const handleRefresh = useCallback(async (): Promise<void> => {
    if (!selectedRepo) {
      return;
    }
    const result = await window.electronAPI.missionControl.refresh(selectedRepo.id);
    if (!result.success) {
      notifications.show({ color: 'red', title: 'Refresh failed', message: result.error });
      throw new Error(result.error);
    }
  }, [selectedRepo]);

  return (
    <MissionControlView
      repositories={repositories}
      selectedRepositoryId={selectedRepo?.id ?? null}
      baseBranch={currentBranch}
      cards={cards}
      onSelectRepository={handleSelectRepository}
      onOpenTerminal={handleOpenTerminal}
      onReview={requestOpenReviewWindow}
      onMarkActive={handleMarkActive}
      onForget={handleForget}
      onTeardown={handleTeardown}
      onProvision={handleProvision}
      onRefresh={handleRefresh}
    />
  );
}
