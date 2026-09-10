"use client";

// Saved sessions, in the URL.
//
// The Level 2 list asks for saved sessions. The cheapest correct implementation
// is the address bar: a session that lives in the URL is shareable, survives a
// reload, is bookmarkable, works across machines, needs no storage permission
// and cannot go stale against a server-side record. localStorage would give
// none of that and would still need this serializer.
//
// Two rules make it safe to write on every change:
//
//   * `replaceState`, never `pushState`. Every depth-slider drag would
//     otherwise become a history entry and the back button would take a
//     hundred presses to leave the page.
//   * The hash is a *hint*, not a source of truth. Anything malformed is
//     ignored field by field, so a hand-edited or truncated link degrades to a
//     default session instead of a blank screen.

import type { BBox, CoverageMetric } from "@/lib/api/types";
import type { Theme } from "@/lib/theme";
import { useSessionStore } from "@/state/useSessionStore";

export interface SessionSnapshot {
  v: 1;
  variable?: string;
  depth?: number;
  t?: number;
  bbox?: BBox;
  /** Four corners, when the region was drawn as a quadrilateral. */
  quad?: [number, number][];
  dr?: [number, number];
  block?: boolean;
  exag?: number;
  metric?: CoverageMetric | null;
  anomaly?: boolean;
  theme?: Theme;
  /** platform:id of the open profile, so a shared link opens on it. */
  sel?: string;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function isBBox(v: unknown): v is BBox {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export function snapshot(): SessionSnapshot {
  const s = useSessionStore.getState();
  return {
    v: 1,
    variable: s.variable,
    depth: Math.round(s.depth),
    t: s.timeIndex,
    bbox: s.selection ?? undefined,
    quad: s.selectionQuad ?? undefined,
    dr: s.depthRange,
    block: s.phase === "block" || s.phase === "holding",
    exag: s.exaggeration,
    metric: s.coverageMetric,
    anomaly: s.showAnomaly,
    theme: s.theme,
    sel: s.selectedProfile
      ? `${s.selectedProfile.platform}:${s.selectedProfile.id}`
      : undefined,
  };
}

function encode(snap: SessionSnapshot): string {
  // Base64url of JSON. Compact enough for a link, and readable with one
  // atob() when someone asks what a shared URL actually contains -- which is
  // the difference between a permalink and an opaque token.
  const json = JSON.stringify(snap);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decode(raw: string): SessionSnapshot | null {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    const o = JSON.parse(json) as Record<string, unknown>;
    if (o.v !== 1) return null;
    return o as unknown as SessionSnapshot;
  } catch {
    return null;
  }
}

export function permalink(): string {
  return `${location.origin}${location.pathname}#s=${encode(snapshot())}`;
}

/** Read the hash once, at mount. Returns what was there, or null. */
export function readHash(): SessionSnapshot | null {
  if (typeof location === "undefined") return null;
  const m = /(?:^|[#&])s=([^&]+)/.exec(location.hash);
  return m ? decode(m[1]) : null;
}

/**
 * Apply a snapshot to the store.
 *
 * Applied field by field with its own guard, so a link written by an older
 * build -- or edited by hand -- restores what it can and leaves the rest at
 * defaults, rather than throwing halfway and leaving the store half-set.
 */
export function applySnapshot(snap: SessionSnapshot): void {
  const st = useSessionStore.getState();
  if (typeof snap.variable === "string") st.setVariable(snap.variable);
  const d = num(snap.depth);
  if (d !== undefined) st.setDepth(d);
  const t = num(snap.t);
  if (t !== undefined) st.setTimeIndex(Math.max(0, Math.round(t)));
  // Selection before quad: setSelection clears the quad, so restoring them the
  // other way round would drop the shape from every shared link.
  if (isBBox(snap.bbox)) st.setSelection(snap.bbox);
  const quad = snap.quad;
  if (
    Array.isArray(quad) &&
    quad.length === 4 &&
    quad.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
  ) {
    st.setSelectionQuad(quad as [number, number][]);
  }
  const dr = snap.dr;
  if (Array.isArray(dr) && dr.length === 2 && dr.every((n) => Number.isFinite(n))) {
    st.setDepthRange([dr[0], dr[1]]);
  }
  const e = num(snap.exag);
  if (e !== undefined) st.setExaggeration(Math.min(10, Math.max(1, e)));
  if (snap.metric !== undefined) st.setCoverageMetric(snap.metric ?? null);
  if (typeof snap.anomaly === "boolean" && snap.anomaly !== st.showAnomaly) {
    st.toggle("showAnomaly");
  }
  if (snap.theme === "dark" || snap.theme === "light") st.setTheme(snap.theme);
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Mirror the store into the hash, coalesced. Returns an unsubscribe. */
export function startPermalinkSync(): () => void {
  let warned = false;
  const write = () => {
    timer = null;
    try {
      history.replaceState(null, "", `#s=${encode(snapshot())}`);
    } catch (e) {
      // A sandboxed frame refuses replaceState, and Chrome throttles it after
      // enough calls in a short window. The app is unaffected either way, so
      // this must not throw -- but swallowing it entirely means saved sessions
      // stop working and nothing anywhere says so. Once is enough; this runs
      // on a debounce and would otherwise fill the console.
      if (!warned) {
        warned = true;
        console.warn("session links unavailable:", e);
      }
    }
  };
  const unsub = useSessionStore.subscribe(() => {
    // 400 ms: long enough that a slider drag writes once at the end, short
    // enough that copying the link right after a click gets the new state.
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, 400);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
