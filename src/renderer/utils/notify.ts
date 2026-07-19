import React from 'react';
import { notifications } from '@mantine/notifications';
import { IconGitCommit, IconX } from '@tabler/icons-react';

export function notifyError(title: string, error: unknown): void {
  notifications.show({
    title,
    message: error instanceof Error ? error.message : String(error),
    color: 'red',
    icon: React.createElement(IconX, { size: 20 }),
  });
}

export function notifySuccess(title: string, message: string): void {
  notifications.show({
    title,
    message,
    color: 'green',
    icon: React.createElement(IconGitCommit, { size: 20 }),
  });
}
