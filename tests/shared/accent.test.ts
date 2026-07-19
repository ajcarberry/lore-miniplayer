import { LORE_ACCENT_HUES, ACCENT_HUE_VALUES, loreAccent, accentStyleVars } from '../../src/shared/accent';

describe('LORE_ACCENT_HUES', () => {
  it('should define the four named accent hues', () => {
    // Then: the named hues match the approved design values
    expect(LORE_ACCENT_HUES).toEqual({ amber: 74, verdigris: 172, arcane: 296, ember: 38 });
  });

  it('should list all four hue values in a stable order for round-robin assignment', () => {
    // Then: the value list mirrors declaration order
    expect(ACCENT_HUE_VALUES).toEqual([74, 172, 296, 38]);
  });
});

describe('loreAccent', () => {
  it('should produce the OKLCH ramp for the amber hue', () => {
    // When: building the ramp for hue 74
    const ramp = loreAccent(74, 'light');

    // Then: it matches the approved design ramp
    expect(ramp).toEqual({
      base: 'oklch(0.66 0.11 74)',
      deep: 'oklch(0.46 0.10 74)',
      soft: 'oklch(0.88 0.045 74)',
      glow: 'oklch(0.72 0.13 74)',
      line: 'oklch(0.74 0.09 74)',
    });
  });

  it('should substitute the hue channel for other named accents', () => {
    // When: building ramps for the remaining named hues
    // Then: only the hue channel changes, the ramp shape stays the same
    expect(loreAccent(172, 'light').base).toBe('oklch(0.66 0.11 172)');
    expect(loreAccent(296, 'light').deep).toBe('oklch(0.46 0.10 296)');
    expect(loreAccent(38, 'light').line).toBe('oklch(0.74 0.09 38)');
  });

  it('should produce the warm-dark ramp when the dark scheme is requested', () => {
    // When: building the ramp for hue 74 in the dark scheme
    const ramp = loreAccent(74, 'dark');

    // Then: it mirrors the dark-scheme accent tokens in tokens.css
    expect(ramp).toEqual({
      base: 'oklch(0.74 0.12 74)',
      deep: 'oklch(0.56 0.11 74)',
      soft: 'oklch(0.38 0.06 74)',
      glow: 'oklch(0.80 0.14 74)',
      line: 'oklch(0.70 0.10 74)',
    });
  });

});

describe('accentStyleVars', () => {
  it('should return a CSS custom property record for inline style injection', () => {
    // When: building style vars for the ember hue
    const vars = accentStyleVars(38, 'light');

    // Then: each CSS variable maps to the matching ramp value
    expect(vars).toEqual({
      '--acc': 'oklch(0.66 0.11 38)',
      '--acc-deep': 'oklch(0.46 0.10 38)',
      '--acc-soft': 'oklch(0.88 0.045 38)',
      '--acc-glow': 'oklch(0.72 0.13 38)',
      '--acc-line': 'oklch(0.74 0.09 38)',
    });
  });

  it('should map the dark ramp when the dark scheme is requested', () => {
    // When: building style vars for the ember hue in the dark scheme
    const vars = accentStyleVars(38, 'dark');

    // Then: each CSS variable maps to the matching dark ramp value
    expect(vars).toEqual({
      '--acc': 'oklch(0.74 0.12 38)',
      '--acc-deep': 'oklch(0.56 0.11 38)',
      '--acc-soft': 'oklch(0.38 0.06 38)',
      '--acc-glow': 'oklch(0.80 0.14 38)',
      '--acc-line': 'oklch(0.70 0.10 38)',
    });
  });
});
