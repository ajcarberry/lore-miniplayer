import type { ReactElement, ReactNode } from 'react';
import type { TextProps } from '@mantine/core';
import { Text } from '@mantine/core';

export interface SectionLabelProps extends TextProps {
  readonly children: ReactNode;
  // Per-surface tracking (e.g. '0.08em' in the intention panel, '0.12em' in
  // the review panes, '0.14em' in Mission Control's header/bands); omitted
  // where the surface uses the recipe untracked.
  readonly letterSpacing?: string;
}

// The shared uppercase section-label recipe (xs, 600, dimmed, uppercase) used
// across the review window and Mission Control. Extra Mantine Text props
// (padding, color overrides) pass straight through.
export function SectionLabel({
  children,
  letterSpacing,
  ...textProps
}: SectionLabelProps): ReactElement {
  return (
    <Text
      size='xs'
      fw={600}
      tt='uppercase'
      c='dimmed'
      {...textProps}
      style={{ ...(letterSpacing !== undefined ? { letterSpacing } : {}) }}
    >
      {children}
    </Text>
  );
}
