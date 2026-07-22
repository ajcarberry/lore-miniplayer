import type { ReactElement, ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import type {
  Repository,
  Workspace,
  WorkspaceBand,
  WorkspaceCard,
} from '../../../src/shared/types';

// A valid uuid so payloads that flow through the Zod schemas (the snapshot hook,
// the main watch handler) parse.
export const REPO_ID = '11111111-1111-4111-8111-111111111111';

export function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: REPO_ID,
    name: 'emberfall',
    url: 'lore://host/emberfall',
    localPath: '/Users/rowan/work/emberfall',
    accentHue: 74,
    origin: 'attached',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    instanceId: 'inst-1',
    path: '/Users/rowan/work/emberfall-wt/act2-balance',
    branchName: 'agent/act2-balance',
    revision: 'r130',
    stale: false,
    repositoryId: REPO_ID,
    provisionedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

export function makeCard(
  band: WorkspaceBand,
  overrides: Partial<WorkspaceCard> = {}
): WorkspaceCard {
  const workspace = overrides.workspace ?? makeWorkspace();
  return {
    workspace,
    attention: { band, needsYou: false, reasons: [] },
    isActive: false,
    fileStats: { added: 38, removed: 21 },
    changedFileCount: 3,
    sessionCommits: [
      { revision: 'r130', revisionNumber: 130, message: 'Flatten pacing curve' },
      { revision: 'r129', revisionNumber: 129, message: 'Retune ravine ambush' },
    ],
    lastEventAt: 1000,
    ...overrides,
  };
}

export function renderWithMantine(ui: ReactNode): ReturnType<typeof render> {
  return render((<MantineProvider>{ui}</MantineProvider>) as ReactElement);
}
