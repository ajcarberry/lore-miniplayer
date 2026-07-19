// Pure geometry for the ambient player's window position. On launch,
// resolveRestorePosition honors the saved top-left exactly — even partly
// off-screen, e.g. a negative y tucking the card above the visible area — as
// long as the pill strip (the grabbable bottom band) still intersects some
// display. Only when the strip is unreachable on every display is the window
// rescued: clamped into the work area of the nearest display. The
// expand/collapse helpers below compute the morph bounds; for those the main
// process picks the display via screen.getDisplayMatching.

export interface WindowPosition {
  readonly x: number;
  readonly y: number;
}

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export interface WorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Which edge of the pill the card unfolds from. 'bottom' (default) grows the
// card up and left keeping the bottom-right corner fixed; 'top' is used when
// the pill sits too near the screen top to grow upward, growing the card down
// and keeping the top-right corner fixed (the pill row renders at the card top).
export type ExpandAnchor = 'bottom' | 'top';

// Window footprints. Collapsed is the pill plus breathing room for the
// hover-peek scale and shadow (derived from Pill.tsx: max-width 320 + minHeight
// 64, padded); expanded is the full card. Same width keeps the pill's right
// edge aligned across the morph.
export const COLLAPSED_WINDOW_SIZE: WindowSize = { width: 344, height: 92 };
export const EXPANDED_WINDOW_SIZE: WindowSize = { width: 360, height: 680 };

// Clamp a single axis so the window stays inside [origin, origin + extent].
// When the window is larger than the work area on this axis, there is no valid
// fully-visible offset, so it pins to the work-area origin (best effort).
function clampAxis(value: number, origin: number, extent: number, windowExtent: number): number {
  const max = origin + extent - windowExtent;
  if (max <= origin) {
    return origin;
  }
  if (value < origin) {
    return origin;
  }
  if (value > max) {
    return max;
  }
  return value;
}

// Clamp a desired top-left window position into a display's work area.
export function clampToWorkArea(
  position: WindowPosition,
  size: WindowSize,
  workArea: WorkArea
): WindowPosition {
  return {
    x: clampAxis(position.x, workArea.x, workArea.width, size.width),
    y: clampAxis(position.y, workArea.y, workArea.height, size.height),
  };
}

// Compute the expanded window bounds from the current collapsed bounds, keeping
// the pill's right edge fixed. Grows upward (bottom-anchored) when the display
// work area has room above; otherwise grows downward (top-anchored).
export function computeExpandedBounds(
  collapsed: Bounds,
  expandedSize: WindowSize,
  workArea: WorkArea
): { readonly bounds: Bounds; readonly anchor: ExpandAnchor } {
  const rightEdge = collapsed.x + collapsed.width;
  const x = rightEdge - expandedSize.width;
  const upwardY = collapsed.y + collapsed.height - expandedSize.height;
  if (upwardY >= workArea.y) {
    return {
      anchor: 'bottom',
      bounds: { x, y: upwardY, width: expandedSize.width, height: expandedSize.height },
    };
  }
  return {
    anchor: 'top',
    bounds: { x, y: collapsed.y, width: expandedSize.width, height: expandedSize.height },
  };
}

// Reverse of computeExpandedBounds: shrink expanded bounds back to the collapsed
// footprint, keeping the same corner fixed as the expansion used.
export function computeCollapsedBounds(
  expanded: Bounds,
  collapsedSize: WindowSize,
  anchor: ExpandAnchor
): Bounds {
  const x = expanded.x + expanded.width - collapsedSize.width;
  if (anchor === 'top') {
    return { x, y: expanded.y, width: collapsedSize.width, height: collapsedSize.height };
  }
  const bottomEdge = expanded.y + expanded.height;
  return {
    x,
    y: bottomEdge - collapsedSize.height,
    width: collapsedSize.width,
    height: collapsedSize.height,
  };
}

export interface Display {
  // Full monitor bounds (includes the menu bar / taskbar area).
  readonly bounds: WorkArea;
  // Usable area (excludes menu bar / taskbar) — where a rescued window lands.
  readonly workArea: WorkArea;
}

// Height of the "pill strip": the bottom band of the window the user grabs.
// As long as this strip is reachable on some display, the window is restored
// exactly where it was left (even with a negative y tucking the card off-top).
const PILL_STRIP_DEFAULT_PX = 72;

function rectsIntersect(a: WorkArea, b: WorkArea): boolean {
  if (a.x + a.width <= b.x || a.x >= b.x + b.width) {
    return false;
  }
  if (a.y + a.height <= b.y || a.y >= b.y + b.height) {
    return false;
  }
  return true;
}

function centerDistance(position: WindowPosition, size: WindowSize, area: WorkArea): number {
  const cx = position.x + size.width / 2;
  const cy = position.y + size.height / 2;
  const ax = area.x + area.width / 2;
  const ay = area.y + area.height / 2;
  return Math.hypot(cx - ax, cy - ay);
}

// Restore the saved window position. The player may live anywhere on screen —
// including a negative y that tucks the card above the visible area — so the
// position is honored exactly as long as the pill strip is still reachable on
// some display. Only when the pill strip is entirely off every display is the
// window rescued back onto the nearest display's work area.
export function resolveRestorePosition(
  saved: WindowPosition,
  size: WindowSize,
  displays: readonly Display[],
  pillStripPx: number = PILL_STRIP_DEFAULT_PX
): WindowPosition {
  if (displays.length === 0) {
    return saved;
  }
  const pillStrip: WorkArea = {
    x: saved.x,
    y: saved.y + size.height - pillStripPx,
    width: size.width,
    height: pillStripPx,
  };
  if (displays.some(display => rectsIntersect(pillStrip, display.bounds))) {
    return saved;
  }
  let nearest = displays[0]!;
  let best = centerDistance(saved, size, nearest.bounds);
  for (let index = 1; index < displays.length; index += 1) {
    const display = displays[index]!;
    const distance = centerDistance(saved, size, display.bounds);
    if (distance < best) {
      best = distance;
      nearest = display;
    }
  }
  return clampToWorkArea(saved, size, nearest.workArea);
}
