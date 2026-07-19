import {
  clampToWorkArea,
  resolveRestorePosition,
  computeExpandedBounds,
  computeCollapsedBounds,
} from '../../src/shared/window-position';
import type { WorkArea, WindowSize, Display, Bounds } from '../../src/shared/window-position';

const SIZE: WindowSize = { width: 360, height: 680 };
const PRIMARY: WorkArea = { x: 0, y: 0, width: 1440, height: 900 };

describe('clampToWorkArea', () => {
  it('leaves a fully on-screen position unchanged', () => {
    // Given: a position well within the primary work area
    // When: clamping
    const result = clampToWorkArea({ x: 200, y: 150 }, SIZE, PRIMARY);

    // Then: the position is returned unchanged
    expect(result).toEqual({ x: 200, y: 150 });
  });

  it('pulls a position that runs off the right/bottom edges back on-screen', () => {
    // Given: a position whose window would overflow the right and bottom edges
    // When: clamping
    const result = clampToWorkArea({ x: 1400, y: 880 }, SIZE, PRIMARY);

    // Then: x/y are pinned to the largest fully-visible offset
    expect(result).toEqual({ x: 1440 - 360, y: 900 - 680 });
  });

  it('pulls a position off the top/left edges back to the work-area origin', () => {
    // Given: a negative position (off the top-left of the display)
    // When: clamping
    const result = clampToWorkArea({ x: -50, y: -200 }, SIZE, PRIMARY);

    // Then: it snaps to the work-area origin
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('respects a non-zero work-area origin (e.g. a display to the right)', () => {
    // Given: a secondary display whose work area starts at x=1440
    const secondary: WorkArea = { x: 1440, y: 0, width: 1280, height: 800 };

    // When: a saved position sits past that display's right edge
    const result = clampToWorkArea({ x: 3000, y: 100 }, SIZE, secondary);

    // Then: it clamps within the secondary work area, not the origin
    expect(result).toEqual({ x: 1440 + 1280 - 360, y: 100 });
  });

  it('pins to the work-area origin when the window is larger than the work area', () => {
    // Given: a work area smaller than the window on both axes
    const tiny: WorkArea = { x: 10, y: 20, width: 100, height: 100 };

    // When: clamping any position
    const result = clampToWorkArea({ x: 500, y: 500 }, SIZE, tiny);

    // Then: the window pins to the work-area top-left (best-effort visibility)
    expect(result).toEqual({ x: 10, y: 20 });
  });
});

// SIZE is 360x680, so with the default 72px pill strip the strip spans
// y = saved.y + 608 .. saved.y + 680.
const D0: Display = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
};
const D1: Display = {
  bounds: { x: 1440, y: 0, width: 1280, height: 800 },
  workArea: { x: 1440, y: 25, width: 1280, height: 775 },
};

describe('resolveRestorePosition', () => {
  it('returns the saved position unchanged when there are no displays', () => {
    expect(resolveRestorePosition({ x: 100, y: 100 }, SIZE, [])).toEqual({ x: 100, y: 100 });
  });

  it('honors the saved position exactly when the pill strip is on a display', () => {
    // Given: a normal on-screen position (pill strip at y 708..780)
    // Then: it is restored exactly
    expect(resolveRestorePosition({ x: 100, y: 100 }, SIZE, [D0])).toEqual({ x: 100, y: 100 });
  });

  it('honors a negative y that tucks the card off the top, as long as the pill shows', () => {
    // Given: y = -500 → the pill strip sits at y 108..180, still on the display
    // Then: the exact (negative-y) position is preserved — moveable anywhere
    expect(resolveRestorePosition({ x: 100, y: -500 }, SIZE, [D0])).toEqual({ x: 100, y: -500 });
  });

  it('rescues a window whose pill strip fell off the bottom of every display', () => {
    // Given: y = 2000 → pill strip at y 2608, below the display
    // Then: it is clamped back into the display work area
    expect(resolveRestorePosition({ x: 100, y: 2000 }, SIZE, [D0])).toEqual({ x: 100, y: 220 });
  });

  it('rescues a pill strip off the left edge', () => {
    // Given: x = -1000 → strip x -1000..-640, entirely left of the display
    expect(resolveRestorePosition({ x: -1000, y: 100 }, SIZE, [D0])).toEqual({ x: 0, y: 100 });
  });

  it('rescues a pill strip off the right edge', () => {
    // Given: x = 2000 → strip left edge past the display's right edge
    expect(resolveRestorePosition({ x: 2000, y: 100 }, SIZE, [D0])).toEqual({ x: 1080, y: 100 });
  });

  it('rescues a pill strip off the top edge', () => {
    // Given: y = -800 → strip y -192..-120, entirely above the display
    expect(resolveRestorePosition({ x: 100, y: -800 }, SIZE, [D0])).toEqual({ x: 100, y: 25 });
  });

  it('rescues onto the nearest display when several exist (nearest = second)', () => {
    // Given: off the bottom near the secondary display
    expect(resolveRestorePosition({ x: 1500, y: 2000 }, SIZE, [D0, D1])).toEqual({
      x: 1500,
      y: 120,
    });
  });

  it('rescues onto the nearest display when several exist (nearest = first)', () => {
    // Given: off the bottom near the primary display
    expect(resolveRestorePosition({ x: 100, y: 2000 }, SIZE, [D0, D1])).toEqual({
      x: 100,
      y: 220,
    });
  });
});

const COLLAPSED: WindowSize = { width: 368, height: 108 };
const EXPANDED: WindowSize = { width: 360, height: 680 };
const WORK_AREA: WorkArea = { x: 0, y: 25, width: 1440, height: 875 };

describe('computeExpandedBounds', () => {
  it('grows upward (bottom anchor) when there is room above the pill', () => {
    // Given: a collapsed window near the bottom of the display
    const collapsed: Bounds = { x: 100, y: 800, width: 368, height: 108 };

    // When: expanding
    const result = computeExpandedBounds(collapsed, EXPANDED, WORK_AREA);

    // Then: bottom-right stays fixed, the card grows up and left
    expect(result.anchor).toBe('bottom');
    expect(result.bounds).toEqual({ x: 108, y: 228, width: 360, height: 680 });
  });

  it('grows downward (top anchor) when the pill is too near the screen top', () => {
    // Given: a collapsed window near the top of the display
    const collapsed: Bounds = { x: 100, y: 10, width: 368, height: 108 };

    // When: expanding
    const result = computeExpandedBounds(collapsed, EXPANDED, WORK_AREA);

    // Then: the top edge stays fixed, the card grows down
    expect(result.anchor).toBe('top');
    expect(result.bounds).toEqual({ x: 108, y: 10, width: 360, height: 680 });
  });
});

describe('computeCollapsedBounds', () => {
  it('shrinks to the bottom-right corner for a bottom-anchored card', () => {
    const expanded: Bounds = { x: 108, y: 228, width: 360, height: 680 };
    expect(computeCollapsedBounds(expanded, COLLAPSED, 'bottom')).toEqual({
      x: 100,
      y: 800,
      width: 368,
      height: 108,
    });
  });

  it('shrinks to the top-right corner for a top-anchored card', () => {
    const expanded: Bounds = { x: 108, y: 10, width: 360, height: 680 };
    expect(computeCollapsedBounds(expanded, COLLAPSED, 'top')).toEqual({
      x: 100,
      y: 10,
      width: 368,
      height: 108,
    });
  });
});
