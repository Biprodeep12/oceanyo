"use client";

// Zoom controls live in the right-hand rail, but what they act on depends on
// the mode: MapLibre in map mode, the orbit camera in block mode. Rather than
// pushing camera commands through the store (which would re-render the tree on
// every click) each renderer registers its handlers here while it is the
// visible one, and the rail just calls them.

export interface ViewportHandlers {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

let active: ViewportHandlers | null = null;

export function registerViewport(handlers: ViewportHandlers | null): void {
  active = handlers;
}

/** Release only if we are still the registered owner, so a late unmount from
 *  the outgoing renderer cannot clear the incoming one. */
export function releaseViewport(handlers: ViewportHandlers): void {
  if (active === handlers) active = null;
}

export const viewport: ViewportHandlers = {
  zoomIn: () => active?.zoomIn(),
  zoomOut: () => active?.zoomOut(),
  reset: () => active?.reset(),
};
