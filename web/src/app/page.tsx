"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";

import ControlPanel from "@/components/controls/ControlPanel";
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
  const presets = useSessionStore((st) => st.presets);
  const variable = useSessionStore((st) => st.variable);
  const health = useSessionStore((st) => st.health);
  const applyPreset = useSessionStore((st) => st.applyPreset);
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
  const synthetic = health?.synthetic ?? true;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#06121c] text-slate-100">
      <MapView visible={!inBlock} />
      <BlockCanvas visible={inBlock} />

      {/* header */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-3">
        <div className="pointer-events-auto rounded-lg border border-slate-700/60 bg-slate-900/90 px-3 py-2 backdrop-blur">
          <div className="text-sm font-semibold tracking-tight">
            Ocean Model&ndash;Observation Platform
          </div>
          <div className="text-[10px] text-slate-400">
            SIH 26067 &middot; Indian EEZ / Bay of Bengal
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          {synthetic && (
            <div
              className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-amber-300"
              title={health?.source ?? ""}
            >
              Synthetic data
            </div>
          )}
          {health?.standards && (
            <div className="rounded-md border border-slate-700/60 bg-slate-900/90 px-2.5 py-1.5 font-mono text-[9px] text-slate-400">
              CF-1.8
              {health.standards.wms ? " · WMS" : ""}
              {health.standards.opendap ? " · OPeNDAP" : ""}
            </div>
          )}
        </div>
      </div>

      {/* left controls */}
      <div className="pointer-events-none absolute left-3 top-[68px] z-20">
        <ControlPanel />
      </div>

      {/* right panel */}
      <div className="pointer-events-auto absolute right-3 top-[68px] z-20">
        <MatchupPanel />
      </div>

      {/* bottom bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-center gap-3 p-3">
        {!inBlock ? (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-900/90 px-3 py-2 backdrop-blur">
            <span className="text-[11px] text-slate-400">
              {selection
                ? `${selection[0].toFixed(2)}, ${selection[1].toFixed(2)} to ${selection[2].toFixed(2)}, ${selection[3].toFixed(2)}`
                : "Shift+drag on the map, or pick a region"}
            </span>
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p)}
                className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                title={p.note}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={dive}
              disabled={!selection}
              className="rounded bg-teal-500 px-4 py-1.5 text-[12px] font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
            >
              Dive
            </button>
          </div>
        ) : (
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-slate-700/60 bg-slate-900/90 px-3 py-2 backdrop-blur">
            <button
              onClick={back}
              className="rounded border border-slate-700 px-3 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              Back to map
            </button>
            <span className="text-[11px] text-slate-500">
              {phase === "block"
                ? "drag to orbit · scroll to zoom · click a float"
                : "loading water column..."}
            </span>
          </div>
        )}
      </div>
    </main>
  );
}
