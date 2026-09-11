"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import AssistantPanel from "@/components/panels/AssistantPanel";
import CommandPalette from "@/components/shell/CommandPalette";
import HoverBubble from "@/components/shell/HoverBubble";
import IconRail from "@/components/shell/IconRail";
import LayersPanel from "@/components/shell/LayersPanel";
import Legend from "@/components/shell/Legend";
import LocatorInset from "@/components/shell/LocatorInset";
import Logo from "@/components/shell/Logo";
import SelectionTag from "@/components/shell/SelectionTag";
import StatusBar from "@/components/shell/StatusBar";
import Timeline from "@/components/shell/Timeline";
import MatchupPanel from "@/components/panels/MatchupPanel";
import { api } from "@/lib/api/client";
import { applySnapshot, readHash, startPermalinkSync } from "@/lib/session/permalink";
import { initialTheme } from "@/lib/theme";
import { diveHandoff, frameSelection } from "@/lib/geo/dive";
import { registerModeActions } from "@/lib/viewport";
import { useIsTouch } from "@/state/useMediaQuery";
import { useSessionStore } from "@/state/useSessionStore";

// Both renderers touch window/WebGL, so neither can server-render.
const MapView = dynamic(() => import("@/components/map/MapView"), { ssr: false });
const BlockCanvas = dynamic(() => import("@/components/block/BlockCanvas"), { ssr: false });

const EXTRUDE_MS = 1500;

export default function Page() {
  // Narrow selectors, deliberately. Subscribing to the whole store would
  // re-render this entire tree on every blockProgress update -- 60 times a
  // second for the length of the extrude -- which is exactly the stutter that
  // ruins the transition. blockProgress is never subscribed to here; the
  // animation reads it through getState().
  const phase = useSessionStore((st) => st.phase);
  const selection = useSessionStore((st) => st.selection);
  const drawMode = useSessionStore((st) => st.drawMode);
  const drawShape = useSessionStore((st) => st.drawShape);
  const selectionQuad = useSessionStore((st) => st.selectionQuad);
  const drawAnchor = useSessionStore((st) => st.drawAnchor);
  const variable = useSessionStore((st) => st.variable);
  const setPhase = useSessionStore((st) => st.setPhase);
  const setBlockProgress = useSessionStore((st) => st.setBlockProgress);
  const reset = useSessionStore((st) => st.reset);
  const rafRef = useRef<number | null>(null);
  // Telling a phone user to hold shift is worse than saying nothing.
  const touch = useIsTouch();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const assistantOpen = useSessionStore((st) => st.assistantOpen);

  // --- theme and any shared session, before anything paints ---
  useEffect(() => {
    const shared = readHash();
    // An explicit theme in a shared link wins over this machine's preference:
    // the point of sending someone a link is that they see what you saw.
    useSessionStore.getState().setTheme(shared?.theme ?? initialTheme());
    if (shared) applySnapshot(shared);
    const stop = startPermalinkSync();
    // Debug handle, alongside `__map` and `__floatPoints`. The browser test
    // needs to select a region derived from the DATA -- where the gliders in
    // this particular catalog actually are -- rather than a preset that only
    // matches the synthetic layout. Driving that through the map would mean
    // simulating a pixel drag whose meaning depends on the current zoom.
    (window as unknown as { __store?: unknown }).__store = useSessionStore;
    return stop;
  }, []);

  // --- Ctrl/Cmd+K opens search ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      // "/" is the other convention, but only when nothing is being typed
      // into -- otherwise it swallows the character in the search box itself.
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setPaletteOpen(true);
      }
      // Escape drops the region -- but only on the map, and only when nothing
      // else is listening for it. In the block it would clear the region the
      // scene is built from, and a popover or the palette has a better claim
      // on the key while it is open.
      if (e.key === "Escape") {
        const st = useSessionStore.getState();
        const typing =
          e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
        const transient = document.querySelector("[data-transient]");
        if (!typing && !transient && st.phase === "map" && (st.selection || st.drawMode)) {
          st.clearSelection();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);



  // --- bootstrap the catalog ---
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const [health, variables, presets, parsers] = await Promise.all([
          api.health(ac.signal),
          api.variables(ac.signal),
          api.presets(ac.signal).catch(() => []),
          // What the instruments measure, which is not what the model carries.
          // The assessment layers need both to know which of them mean
          // anything for the field on screen.
          api.platforms(ac.signal).catch(() => []),
        ]);
        const st = useSessionStore.getState();
        st.setHealth(health);
        st.setVariables(variables);
        st.setPresets(presets);
        st.setParsers(parsers);
        const meta = await api.metadata(variables[0]?.variable ?? "temperature", ac.signal);
        st.setTimes(meta.time);
        // The full extent this catalog serves, taken from the axes themselves
        // rather than hardcoded, so the locator is right for any region.
        if (meta.lon?.length && meta.lat?.length) {
          st.setDomain([
            Math.min(...meta.lon),
            Math.min(...meta.lat),
            Math.max(...meta.lon),
            Math.max(...meta.lat),
          ]);
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error(e);
      }
    })();
    return () => ac.abort();
  }, []);

  // --- observations, loaded last: small, and never gates the transition ---
  useEffect(() => {
    const ac = new AbortController();
    api
      .observations({ limit: 4000 }, ac.signal)
      .then((c) => useSessionStore.getState().setObservations(c.features, c.total))
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // --- error colouring for the instrument markers ---
  useEffect(() => {
    const ac = new AbortController();
    api
      .matchupSummary({ variable, limit: 300 }, ac.signal)
      .then((r) => {
        const map: Record<string, number> = {};
        for (const row of r.results) {
          if (row.bias !== null) map[row.id] = Math.abs(row.bias);
        }
        useSessionStore.getState().setErrorById(map);
      })
      .catch(() => {});
    return () => ac.abort();
  }, [variable]);

  // --- the extrude transition ---
  //
  // Two movements, not one. The map first centres the selection and reports
  // the pixels it occupies; only then does the 3D scene take over, with its
  // camera placed so the block's top face lands on exactly those pixels. The
  // swap is therefore invisible, and the extrude that follows grows a block
  // downward out of a rectangle the viewer is already looking at.
  const runExtrude = () => {
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / EXTRUDE_MS);
      // easeInOutCubic
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setBlockProgress(eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        // If the volume has not arrived, hold at the tilted state with the
        // seabed visible rather than freezing; BlockScene advances to "block"
        // as soon as stage 1 resolves.
        const st = useSessionStore.getState();
        if (st.phase === "extruding") st.setPhase("holding");
      }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  const dive = () => {
    const st = useSessionStore.getState();
    if (!st.selection || st.phase !== "map") return;
    setPhase("framing");
    void frameSelection(st.selection).then((handoff) => {
      // A null handoff is not a failure: a shared permalink can open straight
      // into the block with no map to ask, and the scene then uses its own
      // fitted camera -- which is what every dive did before this existed.
      diveHandoff.set(handoff);
      if (useSessionStore.getState().phase !== "framing") return; // cancelled
      setPhase("extruding");
      runExtrude();
    });
  };

  const back = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPhase("returning");
    const t0 = performance.now();
    const from = useSessionStore.getState().blockProgress;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 900);
      // easeInOutCubic here too, so leaving retraces the path it arrived by
      // rather than snapping out of the tilt.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setBlockProgress(from * (1 - eased));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else {
        diveHandoff.clear();
        reset();
      }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  // The palette can extrude too, so the two actions are published on the same
  // bus the zoom controls use rather than duplicated.
  useEffect(() => registerModeActions(dive, back));

  // "framing" deliberately does NOT count: the map is still the visible
  // renderer while it centres the selection.
  const inBlock = phase === "extruding" || phase === "holding" || phase === "block";
  const settling = phase === "extruding" || phase === "holding";

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[color:var(--ze-ocean)]">
      {/* Both renderers stay mounted across the whole transition, and each
          one hides only once the other is covering it. The map is what the
          block's lid is registered against, so hiding it at the swap would
          remove the very thing that makes the swap invisible.

          The block shows from "extruding" onward -- NOT during "framing".
          While the map is still moving the rectangle into place there is no
          handoff yet, so the camera is still at its fitted pose: showing the
          block then puts a stray sliver of it over a sliding map, half a
          second before the one frame where the two are supposed to line up. */}
      <MapView visible={phase !== "block" && phase !== "holding"} />
      <BlockCanvas
        visible={
          phase === "extruding" ||
          phase === "holding" ||
          phase === "block" ||
          phase === "returning"
        }
      />

      <div className="pointer-events-auto absolute left-2 top-2 z-30 md:left-3 md:top-3">
        <Logo />
      </div>
      {/* ze-scroll, not a bare overflow: with the block layers expanded this
          panel is taller than a laptop viewport, and the platform's default
          scrollbar is a light chunky bar straight through the dark panel. */}
      <div className="ze-scroll pointer-events-auto z-40 md:absolute md:left-3 md:top-[78px] md:z-30 md:max-h-[calc(100dvh-190px)] md:overflow-y-auto">
        <LayersPanel />
      </div>

      <IconRail />

      {/* No positioning wrapper: .ze-side-panel places itself, and a wrapper
          that also positioned it meant two places to change when the rail
          moved. */}
      <MatchupPanel />

      {/* colour scale: bottom-left on a desktop, a full-width strip above the
          time bar on a phone, where there is no room beside it */}
      <div className="absolute bottom-[92px] left-2 right-2 z-20 md:bottom-7 md:left-3 md:right-auto">
        <Legend />
      </div>

      {/* bottom-centre: time, and the one action that changes mode */}
      <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-30 flex flex-col items-center gap-2 md:bottom-6 md:left-1/2 md:right-auto md:-translate-x-1/2">
        {settling && (
          <span className="ze-chip pointer-events-none">
            <span className="text-[color:var(--ze-text-dim)]">
              loading the water column&hellip;
            </span>
          </span>
        )}
        <div className="flex w-full items-stretch gap-2 md:w-auto md:items-end">
          <Timeline />
          {/* Clearing is offered where the region is acted on, not hidden in a
              menu: the rectangle is the one thing on screen with no obvious
              way back, and redrawing over it was the only exit. */}
          {!inBlock && selection && (
            <button
              onClick={() => useSessionStore.getState().clearSelection()}
              className="ze-btn pointer-events-auto h-auto px-3 text-[13px] md:h-[46px]"
              title="Clear the selected region (Esc)"
              aria-label="Clear region"
            >
              Clear
            </button>
          )}
          {!inBlock ? (
            <button
              onClick={dive}
              disabled={!selection || phase === "framing"}
              className="ze-btn ze-btn-primary pointer-events-auto h-auto px-5 text-[14px] md:h-[46px] md:px-6"
              title={
                selection
                  ? selectionQuad
                    ? "Extrude the four-corner region; the block is clipped to it"
                    : "Extrude the selected region into a 3D block"
                  : "Pick a region first: shift+drag on the map, or use Regions"
              }
            >
              Dive
            </button>
          ) : (
            <button
              onClick={back}
              className="ze-btn pointer-events-auto h-auto px-4 text-[13px] md:h-[46px]"
            >
              Back to map
            </button>
          )}
        </div>
        {!inBlock && (drawMode || !selection) && (
          <span className="ze-overlay-text pointer-events-none text-center">
            {drawMode
              ? drawShape === "quad"
                ? "tap four corners, in order around the shape"
                : drawAnchor
                  ? "tap the opposite corner"
                  : "tap one corner of the region"
              : touch
                ? "tap Draw region, then two corners"
                : "use Draw region, or shift+drag on the map"}
          </span>
        )}
        {phase === "block" && (
          <span className="ze-overlay-text pointer-events-none" data-testid="block-hint">
            drag to orbit &middot; {touch ? "pinch" : "scroll"} to zoom &middot;{" "}
            {touch ? "tap" : "click"} a float
          </span>
        )}
      </div>

      {/* Bottom-right, clear of BOTH the status badges and MapLibre's own
          scale bar, which also lives in this corner. 52px was enough for the
          badges alone and put the inset straight through the scale. */}
      <div className="pointer-events-auto absolute bottom-[104px] right-3 z-20 hidden md:block">
        <LocatorInset />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {assistantOpen && (
        <AssistantPanel
          onClose={() => useSessionStore.getState().setAssistantOpen(false)}
        />
      )}
      <SelectionTag />
      <HoverBubble />
      <StatusBar />
    </main>
  );
}
