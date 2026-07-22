import type { ReactElement } from 'react';
import { Text, Tooltip } from '@mantine/core';
import type { Repository } from '../../shared/types';
import { repoEyebrowLabel } from '../utils/repository-name';

interface RepoEyebrowProps {
  readonly repository: Repository | null;
  readonly fallbackLabel?: string;
}

// Shared props for the tiny uppercase eyebrow that sits above a branch name
// in the pill and the card header — one definition so the two surfaces never
// drift apart on design tweaks.
const eyebrowTextProps = {
  size: '9px',
  fw: 700,
  c: 'dimmed',
  tt: 'uppercase',
} as const;

// The repo-name eyebrow: the repository's identity (repo name, plus the
// workspace's own name when it isn't redundant with that repo — see
// `repoEyebrowLabel`), its tooltip carrying the local checkout path so two
// clones of the same repo stay distinguishable. With no repository it
// renders the static fallback label when given (card header) or nothing at
// all (pill).
export function RepoEyebrow({ repository, fallbackLabel }: RepoEyebrowProps): ReactElement | null {
  if (!repository) {
    if (fallbackLabel === undefined) {
      return null;
    }
    return (
      <Text {...eyebrowTextProps} style={{ letterSpacing: '0.08em' }}>
        {fallbackLabel}
      </Text>
    );
  }
  return (
    <Tooltip label={repository.localPath}>
      <Text {...eyebrowTextProps} truncate style={{ letterSpacing: '0.08em', maxWidth: 180 }}>
        {repoEyebrowLabel(repository)}
      </Text>
    </Tooltip>
  );
}
