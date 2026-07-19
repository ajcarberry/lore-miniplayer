// Per-repository accent ramp. Pure, side-effect-free, safe to import from
// both the main and renderer processes.

export const LORE_ACCENT_HUES = { amber: 74, verdigris: 172, arcane: 296, ember: 38 } as const;

// Declaration order drives round-robin assignment of new repositories.
export const ACCENT_HUE_VALUES: readonly number[] = Object.values(LORE_ACCENT_HUES);

export interface AccentRamp {
  readonly base: string;
  readonly deep: string;
  readonly soft: string;
  readonly glow: string;
  readonly line: string;
}

export function loreAccent(hue: number): AccentRamp {
  return {
    base: `oklch(0.66 0.11 ${hue})`,
    deep: `oklch(0.46 0.10 ${hue})`,
    soft: `oklch(0.88 0.045 ${hue})`,
    glow: `oklch(0.72 0.13 ${hue})`,
    line: `oklch(0.74 0.09 ${hue})`,
  };
}

export interface AccentStyleVars {
  readonly '--acc': string;
  readonly '--acc-deep': string;
  readonly '--acc-soft': string;
  readonly '--acc-glow': string;
  readonly '--acc-line': string;
}

export function accentStyleVars(hue: number): AccentStyleVars {
  const ramp = loreAccent(hue);
  return {
    '--acc': ramp.base,
    '--acc-deep': ramp.deep,
    '--acc-soft': ramp.soft,
    '--acc-glow': ramp.glow,
    '--acc-line': ramp.line,
  };
}
