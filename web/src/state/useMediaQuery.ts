"use client";

// Viewport queries, SSR-safe.
//
// The initial value is deliberately `false` on both server and client, and
// only corrects after mount. Reading `window.matchMedia` during render would
// make the server and first client render differ, which React 19 reports as a
// hydration mismatch and then re-renders the whole tree -- the same trap the
// GPU probe fell into.

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** Phone-sized: the panels become sheets and the rail shrinks. */
export const useIsMobile = () => useMediaQuery("(max-width: 767px)");

/** No hover: the pointer readout has to be driven by taps instead. */
export const useIsTouch = () => useMediaQuery("(hover: none)");
