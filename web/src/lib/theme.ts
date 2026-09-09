"use client";

// Light / dark, in one place.
//
// The tokens live in globals.css and everything drawn by CSS follows them for
// free. Two renderers cannot: three.js and MapLibre take real colour values,
// not `var(--x)`, so they read the resolved token off the document whenever the
// theme changes. That keeps ONE definition of the palette rather than a CSS
// copy and a JavaScript copy that drift.
//
// The field colormaps are deliberately NOT themed. They are scientific scales
// with published meanings, the colour bar is the legend for them, and a
// "light-mode thermal" would be a different scale wearing the same name.

export type Theme = "dark" | "light";

const KEY = "oceanups.theme";

/** Read a resolved CSS token. Returns the fallback before hydration. */
export function token(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v.trim() || fallback;
}

export function tokenNumber(name: string, fallback: number): number {
  const n = Number.parseFloat(token(name));
  return Number.isFinite(n) ? n : fallback;
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  // The dark palette is the bare :root block, so only light is stamped. That
  // way a missing attribute can never mean "no theme at all".
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private browsing; the choice just will not persist */
  }
}

/**
 * The theme to start in: a previous explicit choice, else the OS preference.
 *
 * Read on the client only. Reading it during render would make the server's
 * HTML and the first client render disagree, which React 19 reports as a
 * hydration mismatch and repairs by re-rendering the whole tree -- during the
 * one second when the map is initialising.
 */
export function initialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
