import { act, renderHook, waitFor } from '@testing-library/react';
import { useExpansion } from '../../../src/renderer/hooks/useExpansion';
import type { PillPointerEvent } from '../../../src/renderer/hooks/useExpansion';
import { installMockElectronAPI } from '../../mocks/electron-api';

interface CaptureTarget {
  setPointerCapture: jest.Mock;
  releasePointerCapture: jest.Mock;
}

function makeTarget(): CaptureTarget {
  return { setPointerCapture: jest.fn(), releasePointerCapture: jest.fn() };
}

function evt(screenX: number, screenY: number, target: CaptureTarget): PillPointerEvent {
  return { pointerId: 1, screenX, screenY, currentTarget: target };
}

describe('useExpansion', () => {
  beforeEach(() => {
    installMockElectronAPI();
  });

  it('starts collapsed when connected', () => {
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    expect(result.current.isExpanded).toBe(false);
  });

  it('is always expanded while disconnected (no pill to collapse to)', () => {
    const { result } = renderHook(() => useExpansion({ isConnected: false }));
    expect(result.current.isExpanded).toBe(true);
  });

  it('captures the pointer on pointerdown without any IPC round-trip', () => {
    // Given: a collapsed, connected player
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();

    // When: pressing the pill
    act(() => result.current.onPillPointerDown(evt(10, 10, target)));

    // Then: the pointer is captured; the window origin comes synchronously
    // from window.screenX/screenY, so no position fetch happens
    expect(target.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it('treats a below-threshold press+release as a click and toggles expand', () => {
    // Given: a collapsed, connected player
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();

    // When: pressing and releasing with only a tiny movement
    act(() => result.current.onPillPointerDown(evt(10, 10, target)));
    act(() => result.current.onPillPointerMove(evt(12, 11, target)));
    act(() => result.current.onPillPointerUp(evt(12, 11, target)));

    // Then: it expands, releases capture, and never moved the window
    expect(result.current.isExpanded).toBe(true);
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(window.electronAPI.window.move).not.toHaveBeenCalled();
  });

  it('treats a past-threshold drag as a window move and suppresses the toggle', () => {
    // Given: the window currently sits at (100, 200) per window.screenX/screenY
    Object.defineProperty(window, 'screenX', { value: 100, configurable: true });
    Object.defineProperty(window, 'screenY', { value: 200, configurable: true });
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();

    // When: pressing, then dragging well past the threshold
    act(() => result.current.onPillPointerDown(evt(0, 0, target)));
    act(() => result.current.onPillPointerMove(evt(50, 0, target)));

    // Then: the window is moved by start-position + pointer delta, synchronously
    expect(window.electronAPI.window.move).toHaveBeenCalledWith(150, 200);

    // And: releasing does NOT toggle expand (it was a drag, not a click)
    act(() => result.current.onPillPointerUp(evt(50, 0, target)));
    expect(result.current.isExpanded).toBe(false);
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('rounds fractional Retina pointer coordinates before moving the window', () => {
    // Given: a fractional window origin and fractional pointer coords, as a
    // Retina display reports them (this is what made the pill immovable: the
    // move IPC rejected non-integer coordinates)
    Object.defineProperty(window, 'screenX', { value: 950, configurable: true });
    Object.defineProperty(window, 'screenY', { value: 169.25, configurable: true });
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();

    // When: dragging with fractional screen coordinates
    act(() => result.current.onPillPointerDown(evt(0.5, 0.25, target)));
    act(() => result.current.onPillPointerMove(evt(51.2421875, 0.9140625, target)));

    // Then: the move is sent with integers only
    expect(window.electronAPI.window.move).toHaveBeenCalledWith(1001, 170);
  });

  it('ignores a pointerup that had no matching pointerdown', () => {
    // Given: a collapsed player and a stray pointerup (e.g. from a child that
    // stopped the pointerdown)
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();

    // When: only a pointerup fires
    act(() => result.current.onPillPointerUp(evt(0, 0, target)));

    // Then: nothing happens — no toggle, no capture release
    expect(result.current.isExpanded).toBe(false);
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('collapses back to the pill on forceCollapse', () => {
    // Given: an expanded, connected player
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();
    act(() => result.current.onPillPointerDown(evt(0, 0, target)));
    act(() => result.current.onPillPointerUp(evt(0, 0, target)));
    expect(result.current.isExpanded).toBe(true);

    // When: the collapse control is used
    act(() => result.current.forceCollapse());

    // Then: it returns to the pill
    expect(result.current.isExpanded).toBe(false);
  });

  it('stays expanded when disconnected even after forceCollapse', () => {
    const { result } = renderHook(() => useExpansion({ isConnected: false }));
    act(() => result.current.forceCollapse());
    expect(result.current.isExpanded).toBe(true);
  });

  it('grows the window and adopts the anchor returned by main when it expands', async () => {
    // Given: main will report a top-anchored expansion
    (window.electronAPI.window.setExpanded as jest.Mock).mockResolvedValue({ anchor: 'top' });
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();

    // When: a click expands the card
    await act(async () => {
      result.current.onPillPointerDown(evt(0, 0, target));
      result.current.onPillPointerUp(evt(0, 0, target));
    });

    // Then: the window is grown and the reported anchor is adopted
    expect(window.electronAPI.window.setExpanded).toHaveBeenCalledWith(true);
    await waitFor(() => expect(result.current.anchor).toBe('top'));
  });

  it('shrinks the window only after the fold transition on collapse', async () => {
    // Given: an expanded, connected player
    const { result } = renderHook(() => useExpansion({ isConnected: true }));
    const target = makeTarget();
    await act(async () => {
      result.current.onPillPointerDown(evt(0, 0, target));
      result.current.onPillPointerUp(evt(0, 0, target));
    });
    (window.electronAPI.window.setExpanded as jest.Mock).mockClear();

    // When: collapsing (CSS folds immediately, window shrinks after the delay)
    act(() => result.current.forceCollapse());

    // Then: the shrink IPC is NOT sent synchronously — shrinking the window
    // before the fold transition would destroy the animation
    expect(window.electronAPI.window.setExpanded).not.toHaveBeenCalled();

    // And: the shrink IPC is eventually sent
    await waitFor(() => expect(window.electronAPI.window.setExpanded).toHaveBeenCalledWith(false), {
      timeout: 1000,
    });
  });
});
