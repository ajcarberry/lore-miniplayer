import { useCallback, useRef, useState } from 'react';
import type { ReviewOpenRequest } from '../../shared/types';

// How long the CSS crossfade runs before the window shrinks back to the card
// footprint on Project View exit — must be >= the .morph-project-view
// transition in morph.css so the surface is gone before the window resizes
// under it.
const PROJECT_VIEW_MORPH_MS = 400;

export interface ProjectViewMorph {
  // The open request the Project View renders, kept mounted through the exit
  // fade; null once fully closed.
  readonly request: ReviewOpenRequest | null;
  // Drives the morph-root's data-project-view crossfade attribute.
  readonly active: boolean;
  // Drives data-card-hidden: once the crossfade has run, the card also leaves
  // the accessibility tree and tab order (see morph.css).
  readonly cardHidden: boolean;
  readonly open: (request: ReviewOpenRequest) => void;
  readonly close: () => void;
  // Collapse straight to the ambient pill (the TitleBar control): closes the
  // view, then folds the card via the supplied pill collapse.
  readonly collapseToPill: () => void;
}

// The card <-> Project View morph. `forcePillCollapse` is useExpansion's
// pill fold, invoked after close on the collapse-to-pill path.
//
// Opening grows the window to the review
// footprint immediately (main also drops always-on-top — window:setView)
// while the CSS crossfade brings the surface in; closing fades the surface
// out first, then shrinks the window back after the fold (anti-flicker,
// mirroring useExpansion's collapse sequencing). The post-fade steps are
// sequenced by a renderer timer, NOT a CSS transition delay (see morph.css);
// each direction cancels the other's pending timer so rapid open/close can
// never strand a stale step.
export function useProjectViewMorph(forcePillCollapse: () => void): ProjectViewMorph {
  const [request, setRequest] = useState<ReviewOpenRequest | null>(null);
  const [active, setActive] = useState(false);
  const [cardHidden, setCardHidden] = useState(false);
  const timer = useRef<number | null>(null);

  const clearTimer = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const open = useCallback((openRequest: ReviewOpenRequest): void => {
    clearTimer();
    setRequest(openRequest);
    setActive(true);
    void window.electronAPI.window.setView('projectView');
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setCardHidden(true);
    }, PROJECT_VIEW_MORPH_MS);
  }, []);

  const close = useCallback((): void => {
    clearTimer();
    setCardHidden(false);
    setActive(false);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setRequest(null);
      void window.electronAPI.window.setView('card');
    }, PROJECT_VIEW_MORPH_MS);
  }, []);

  // A live merge is backed out first (fire-and-forget, the old window-close
  // semantics): leaving it in flight would strand the on-disk merge with no
  // surface driving it. Aborting a merge that already landed is a tolerated
  // no-op.
  const collapseToPill = useCallback((): void => {
    if (request?.workflow === 'merge') {
      void window.electronAPI.merge.abort({ repositoryPath: request.repositoryPath });
    }
    close();
    forcePillCollapse();
  }, [request, close, forcePillCollapse]);

  return { request, active, cardHidden, open, close, collapseToPill };
}
