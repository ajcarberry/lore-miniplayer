import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExpandAnchor } from '../../shared/window-position';

// How far the pointer may move between pointerdown and pointerup and still
// count as a click (expand) rather than a window drag.
const DRAG_THRESHOLD_PX = 5;

// How long the CSS fold runs before the window shrinks on collapse — must be
// >= the .morph-card fold transition in morph.css so the card is gone before
// the window shrinks (avoids clipping the card mid-fold).
const COLLAPSE_TRANSITION_MS = 400;

// The fields the pill drag machine needs from a pointer event. React's
// PointerEvent satisfies this structurally (currentTarget is an HTMLElement,
// which has set/releasePointerCapture).
export interface PillPointerEvent {
  readonly pointerId: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly currentTarget: {
    setPointerCapture: (pointerId: number) => void;
    releasePointerCapture: (pointerId: number) => void;
  };
}

export interface UseExpansionOptions {
  readonly isConnected: boolean;
}

export interface ExpansionControls {
  readonly isExpanded: boolean;
  readonly anchor: ExpandAnchor;
  readonly onPillPointerDown: (event: PillPointerEvent) => void;
  readonly onPillPointerMove: (event: PillPointerEvent) => void;
  readonly onPillPointerUp: (event: PillPointerEvent) => void;
  readonly forceCollapse: () => void;
}

// Click-to-expand + manual-drag morph state for the ambient pill.
//
// The pill is NOT a native `-webkit-app-region: drag` region — Electron routes
// real mouse events on native drag regions to OS window-dragging, so the
// renderer would never see pointerdown/click and click-to-expand could never
// fire for a human. Instead the pill is dragged manually: pointerdown captures
// the pointer and fetches the window's current position; pointermove past a
// small threshold enters drag mode and repositions the window (start position
// + pointer screen-delta) via IPC; pointerup below the threshold is a click and
// toggles the card open. There is no clamping while dragging — the pill may be
// moved anywhere on screen. Disconnected always renders the full card.
//
// The window itself resizes between the pill and card footprints (in main, via
// window:setExpanded) so the transparent area never intercepts clicks meant for
// windows behind it, and so the pill can reach the very top of the screen. An
// effect syncs the window bounds to `isExpanded` with anti-flicker sequencing:
// on expand the window grows (main returns the unfold anchor direction) as the
// card unfolds; on collapse the card folds first, then the window shrinks after
// the fold transition.
export function useExpansion({ isConnected }: UseExpansionOptions): ExpansionControls {
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<ExpandAnchor>('bottom');
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const windowStart = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  const isExpanded = !isConnected || expanded;

  const syncedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (syncedRef.current === isExpanded) {
      return;
    }
    syncedRef.current = isExpanded;
    let cancelled = false;
    if (isExpanded) {
      void window.electronAPI.window.setExpanded(true).then(result => {
        if (!cancelled) {
          setAnchor(result.anchor);
        }
      });
      return (): void => {
        cancelled = true;
      };
    }
    const timer = window.setTimeout(() => {
      void window.electronAPI.window.setExpanded(false);
    }, COLLAPSE_TRANSITION_MS);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [isExpanded]);

  const onPillPointerDown = useCallback((event: PillPointerEvent): void => {
    pointerStart.current = { x: event.screenX, y: event.screenY };
    // The renderer already knows its own window origin — no IPC round-trip
    // (which also raced: moves before the fetch resolved were dropped).
    windowStart.current = { x: window.screenX, y: window.screenY };
    dragging.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPillPointerMove = useCallback((event: PillPointerEvent): void => {
    const start = pointerStart.current;
    const origin = windowStart.current;
    if (start === null || origin === null) {
      return;
    }
    const dx = event.screenX - start.x;
    const dy = event.screenY - start.y;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      dragging.current = true;
    }
    if (dragging.current) {
      // Retina displays report fractional screen coordinates; the window
      // position is integral
      window.electronAPI.window.move(Math.round(origin.x + dx), Math.round(origin.y + dy));
    }
  }, []);

  const onPillPointerUp = useCallback((event: PillPointerEvent): void => {
    // Ignore an up with no matching down (e.g. a child that stopped the down).
    if (pointerStart.current === null) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    const wasDragging = dragging.current;
    pointerStart.current = null;
    windowStart.current = null;
    dragging.current = false;
    if (!wasDragging) {
      setExpanded(prev => !prev);
    }
  }, []);

  const forceCollapse = useCallback((): void => setExpanded(false), []);

  return {
    isExpanded,
    anchor,
    onPillPointerDown,
    onPillPointerMove,
    onPillPointerUp,
    forceCollapse,
  };
}
