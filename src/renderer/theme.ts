import {
  Button,
  Modal,
  Paper,
  Popover,
  TextInput,
  Textarea,
  createTheme,
  type MantineThemeOverride,
} from '@mantine/core';

// Maps the Codex parchment tokens (src/renderer/styles/tokens.css) onto
// Mantine's theme so core surfaces pick up --paper/--ink/--acc in both color
// schemes without per-component overrides.
export const theme: MantineThemeOverride = createTheme({
  fontFamily: 'var(--font-ui)',
  fontFamilyMonospace: 'var(--font-mono)',
  headings: { fontFamily: 'var(--font-disp)' },
  defaultRadius: 'md',
  radius: { md: 'var(--radius)' },
  components: {
    Paper: Paper.extend({
      styles: {
        root: {
          backgroundColor: 'var(--paper-raised)',
          color: 'var(--ink)',
        },
      },
    }),
    Button: Button.extend({
      // Accent fill only for the default (filled, uncolored) button — explicit
      // variants (subtle/light) and colors (red destructive) keep their own
      // Mantine styling.
      styles: (_theme, props) =>
        (props.variant ?? 'filled') === 'filled' && props.color === undefined
          ? {
              root: {
                backgroundColor: 'var(--acc)',
                color: 'var(--paper)',
              },
            }
          : { root: {} },
    }),
    Modal: Modal.extend({
      styles: {
        content: { backgroundColor: 'var(--paper-raised)', color: 'var(--ink)' },
        header: { backgroundColor: 'var(--paper-raised)', color: 'var(--ink)' },
      },
    }),
    Popover: Popover.extend({
      styles: {
        dropdown: {
          backgroundColor: 'var(--paper-raised)',
          color: 'var(--ink)',
          borderColor: 'var(--hair)',
        },
      },
    }),
    TextInput: TextInput.extend({
      styles: {
        input: {
          backgroundColor: 'var(--paper-sink)',
          color: 'var(--ink)',
          borderColor: 'var(--hair)',
        },
      },
    }),
    Textarea: Textarea.extend({
      styles: {
        input: {
          backgroundColor: 'var(--paper-sink)',
          color: 'var(--ink)',
          borderColor: 'var(--hair)',
        },
      },
    }),
  },
});
