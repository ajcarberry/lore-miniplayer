import type { ReactElement } from 'react';
import { useState } from 'react';
import { Button, Code, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import type { Repository } from '../../../shared/types';
import { previewWorkspaceDir } from './format';

export interface ProvisionModalProps {
  readonly opened: boolean;
  readonly repository: Repository | null;
  // The repo's current checkout — the head the new workspace branches from
  // (the P3 provision contract carries only the new branch name).
  readonly baseBranch: string;
  readonly isProvisioning: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (branchName: string) => void;
}

// Rejects an empty name or one with a parent-directory segment. Namespaced
// names (agent/act2-balance) are allowed — P3 nests them under the worktree
// root and only guards against escaping it via "..".
export function validateBranchName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'Branch name is required';
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    return 'Branch name cannot contain a “..” segment';
  }
  return null;
}

// The "+ Provision workspace" flow (design 2a): name a new branch, preview the
// worktree directory P3 will create, and submit. Progress then streams over the
// existing clone-progress channel and the workspace lands in the Idle band.
export function ProvisionModal({
  opened,
  repository,
  baseBranch,
  isProvisioning,
  onClose,
  onSubmit,
}: ProvisionModalProps): ReactElement {
  // Field + touched state reset per opening via the caller's `key` (it remounts
  // this component when the modal opens), so no reset effect.
  const [branchName, setBranchName] = useState('');
  const [touched, setTouched] = useState(false);

  const error = validateBranchName(branchName);
  const preview = repository ? previewWorkspaceDir(repository.localPath, branchName) : '';

  const handleSubmit = (): void => {
    setTouched(true);
    if (error === null && !isProvisioning) {
      onSubmit(branchName.trim());
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title='Provision workspace' centered size='md'>
      <Stack gap='md'>
        <TextInput
          label='Base branch'
          description='The new workspace branches from the current checkout.'
          value={baseBranch}
          readOnly
          disabled
        />
        <TextInput
          data-autofocus
          label='New branch name'
          placeholder='agent/my-task'
          value={branchName}
          onChange={event => setBranchName(event.currentTarget.value)}
          error={touched && error !== null ? error : undefined}
          disabled={isProvisioning}
        />
        <Stack gap={4}>
          <Text size='xs' c='dimmed'>
            Workspace directory
          </Text>
          <Code block>{preview || '—'}</Code>
        </Stack>
        <Group justify='flex-end' gap='sm'>
          <Button variant='subtle' onClick={onClose} disabled={isProvisioning}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isProvisioning || repository === null}
            loading={isProvisioning}
          >
            Provision
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
