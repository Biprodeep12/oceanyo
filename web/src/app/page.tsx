"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";

import HoverBubble from "@/components/shell/HoverBubble";
import IconRail from "@/components/shell/IconRail";
import LayersPanel from "@/components/shell/LayersPanel";
import Legend from "@/components/shell/Legend";
import Logo from "@/components/shell/Logo";
import StatusBar from "@/components/shell/StatusBar";
import Timeline from "@/components/shell/Timeline";
import MatchupPanel from "@/components/panels/MatchupPanel";
import { api } from "@/lib/api/client";
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
  const variable = useSessionStore((st) => st.variable);
  const setPhase = useSessionStore((st) => st.setPhase);
  const setBlockProgress = useSessionStore((st) => st.setBlockProgress);
  const reset = useSessionStore((st) => st.reset);
  const rafRef = useRef<number | null>(null);

  // --- bootstrap the catalog ---
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const [health, variables, presets] = await Promise.all([
          api.health(ac.signal),
          api.variables(ac.signal),
          api.presets(ac.signal).catch(() => []),
        ]);
        const st = useSessionStore.getState();
        st.setHealth(health);
        st.setVariables(variables);
        st.setPresets(presets);
        const meta = await api.metadata(variables[0]?.variable ?? "temperature", ac.signal);
        st.setTimes(meta.time);
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error(e);
      }
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- observations, loaded last: small, and never gates the transition ---
  useEffect(() => {
    const ac = new AbortController();
    api
      .observations({ limit: 4000 }, ac.signal)
      .then((c) => useSessionStore.getState().setObservations(c.features))
      .catch(() => {});
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const dive = () => {
    if (!selection) return;
    setPhase("extruding");
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

  const back = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPhase("returning");
    const t0 = performance.now();
    const from = useSessionStore.getState().blockProgress;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 700);
      setBlockProgress(from * (1 - t));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else reset();
    };
    rafRef.current = requestAnimationFrame(step);
  };

  const inBlock = phase === "extruding" || phase === "holding" || phase === "block";
  const settling = phase === "extruding" || phase === "holding";

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[color:var(--ze-ocean)]">
      <MapView visible={!inBlock} />
      <BlockCanvas visible={inBlock} />

      <div className="pointer-events-auto absolute left-3 top-3 z-30">
        <Logo />
      </div>
      <div className="pointer-events-auto absolute left-3 top-[78px] z-30 max-h-[calc(100dvh-190px)] overflow-y-auto">
        <LayersPanel />
      </div>

      <IconRail />

      <div className="pointer-events-auto absolute right-[62px] top-3 z-30">
        <MatchupPanel />
      </div>

      {/* bottom-left: colour scale, with coordinates beneath it */}
      <div className="absolute bottom-7 left-3 z-20">
        <Legend />
      </div>

      {/* bottom-centre: time, and the one action that changes mode */}
      <div className="pointer-events-none absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
        {settling && (
          <span className="ze-chip pointer-events-none">
            <span className="text-[color:var(--ze-text-dim)]">
              loading the water column&hellip;
            </span>
          </span>
        )}
        <div className="flex items-end gap-2">
          <Timeline />
          {!inBlock ? (
            <button
              onClick={dive}
              disabled={!selection}
              className="ze-btn ze-btn-primary pointer-events-auto h-[46px] px-6 text-[14px]"
              title={
                selection
                  ? "Extrude the selected region into a 3D block"
                  : "Pick a region first: shift+drag on the map, or use Regions"
              }
            >
              Dive
            </button>
          ) : (
            <button
              onClick={back}
              className="ze-btn pointer-events-auto h-[46px] px-4 text-[13px]"
            >
              Back to map
            </button>
          )}
        </div>
        {!inBlock && !selection && (
          <span className="ze-overlay-text pointer-events-none">
            shift+drag on the map to choose a region
          </span>
        )}
        {phase === "block" && (
          <span className="ze-overlay-text pointer-events-none" data-testid="block-hint">
            drag to orbit &middot; scroll to zoom &middot; click a float
          </span>
        )}
      </div>

      <HoverBubble />
      <StatusBar />
    </main>
  );
}
