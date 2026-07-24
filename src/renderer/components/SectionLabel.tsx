import type { ReactElement, ReactNode } from 'react';
import type { TextProps } from '@mantine/core';
import { Text } from '@mantine/core';

export interface SectionLabelProps extends TextProps {
  readonly children: ReactNode;
}

// The shared uppercase section-label recipe (xs, 600, dimmed, uppercase) used
// across the review window and Mission Control. Extra Mantine Text props
// (padding, tracking, color overrides) pass straight through.
export function SectionLabel({ children, ...textProps }: SectionLabelProps): ReactElement {
  return (
    <Text size='xs' fw={600} tt='uppercase' c='dimmed' {...textProps}>
      {children}
    </Text>
  );
}
