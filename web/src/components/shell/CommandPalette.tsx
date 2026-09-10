"use client";

// Search and navigation, and the query layer's front end.
//
// Two Level 2 items land in one surface: "search & navigation" is what this
// is, and section 5.2's query layer is what it resolves through. Everything
// typed here becomes a Tool object from the schema in lib/nlq/tools.ts before
// anything happens, and the resolved call is printed under the highlighted row
// -- section 5.2's "show the resolved parameters ... never let it act
// silently", enforced as a component rather than as a promise.
//
// No model is called. See the header of lib/nlq/tools.ts for why the
// deterministic resolver is the default path rather than the fallback.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IconSearch } from "@/components/ui/icons";
import { api } from "@/lib/api/client";
import { openProfile } from "@/lib/api/openProfile";
import { describe, resolve, type Resolution, type Tool } from "@/lib/nlq/tools";
import { modeActions } from "@/lib/viewport";
import { useSessionStore } from "@/state/useSessionStore";

interface InstrumentRow {
  instrument: string;
  platform: string;
  profiles: number;
  trajectoryKm: number;
  last: string;
  lon: number;
  lat: number;
  rmse: number | null;
  meanAbsBias: number | null;
  lastProfileId: string;
}

const SUGGESTIONS = [
  "Bay of Bengal",
  "salinity at 200 m",
  "blind spots",
  "which floats disagree most with the model",
  "the longest-travelling float",
  "model accuracy",
];

export default function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [rows, setRows] = useState<InstrumentRow[] | null>(null);
  const [ranking, setRanking] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const presets = useSessionStore((s) => s.presets);
  const variables = useSessionStore((s) => s.variables);
  const times = useSessionStore((s) => s.times);
  const observations = useSessionStore((s) => s.observations);

  // Instrument names, not profile ids: a user searching "1902669" means the
  // float, and its ninety cycles as ninety rows would bury everything else.
  const instrumentIds = useMemo(() => {
    const seen = new Set<string>();
    for (const f of observations) seen.add(f.properties.id.split(":")[0]);
    return [...seen];
  }, [observations]);

  const results = useMemo(
    () => resolve(q, { presets, variables, times, instrumentIds }).slice(0, 9),
    [q, presets, variables, times, instrumentIds],
  );

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setRows(null);
      setRanking("");
      // rAF, not a bare focus(): the element is being revealed in the same
      // commit and is not yet focusable when the effect runs.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const run = useCallback(
    async (tool: Tool) => {
      const st = useSessionStore.getState();
      switch (tool.name) {
        case "select_preset": {
          const p = presets.find((x) => x.id === tool.args.region);
          if (p) st.applyPreset(p);
          onClose();
          break;
        }
        case "select_region":
          st.setSelection(tool.args.bbox);
          st.setDepthRange(tool.args.depthRange);
          onClose();
          break;
        case "set_variable":
          st.setVariable(tool.args.variable);
          onClose();
          break;
        case "set_depth":
          st.setDepth(tool.args.depth);
          onClose();
          break;
        case "set_time": {
          const i = times.indexOf(tool.args.time);
          if (i >= 0) st.setTimeIndex(i);
          onClose();
          break;
        }
        case "set_layer":
          if (tool.args.layer === "anomaly") {
            if (!st.showAnomaly) st.toggle("showAnomaly");
          } else if (tool.args.layer === "none") {
            st.setCoverageMetric(null);
          } else {
            st.setCoverageMetric(tool.args.layer);
          }
          onClose();
          break;
        case "dive":
          modeActions.dive();
          onClose();
          break;
        case "focus_platform": {
          // The palette knows the instrument; the store knows which of its
          // cycles are on screen. Pick the newest one that exists, so a focus
          // never lands on a profile the map is not showing.
          const cand = observations
            .filter((f) => f.properties.id.split(":")[0] === tool.args.id)
            .sort((a, b) => (a.properties.time < b.properties.time ? 1 : -1))[0];
          if (cand) await openProfile(cand.properties.platform, cand.properties.id);
          onClose();
          break;
        }
        case "query_floats": {
          // The one call the client cannot answer itself. Section 5.2: the
          // language layer never touches the data -- the ranking is computed
          // server-side against the observation index and returned.
          setBusy(true);
          try {
            const r = await api.instruments({
              sortBy: tool.args.sortBy,
              order: tool.args.order,
              limit: tool.args.limit,
              variable: st.variable,
            });
            setRows(r.results as InstrumentRow[]);
            setRanking(tool.args.sortBy);
          } catch (e) {
            console.warn("query_floats:", e);
            setRows([]);
          } finally {
            setBusy(false);
          }
          break;
        }
      }
    },
    [presets, times, observations, onClose],
  );

  // --- keyboard ---
  const list: Resolution[] = results;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(list.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter" && list[cursor]) {
        e.preventDefault();
        void run(list[cursor].tool);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, list, cursor, run, onClose]);

  if (!open) return null;

  const active = list[cursor];

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/45 px-3 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="ze-panel w-full max-w-[560px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Search and navigate"
      >
        <div className="flex items-center gap-2.5 border-b border-[color:var(--ze-line)] px-4 py-3">
          <IconSearch className="h-4 w-4 shrink-0 text-[color:var(--ze-text-faint)]" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="a region, a variable, a depth, or a question about the floats"
            className="w-full bg-transparent text-[13px] text-[color:var(--ze-text)] outline-none placeholder:text-[color:var(--ze-text-faint)]"
            data-testid="palette-input"
          />
          <kbd className="ze-kbd">esc</kbd>
        </div>

        {/* The resolved tool call, before anything runs. */}
        {active && (
          <div className="border-b border-[color:var(--ze-line)] bg-black/20 px-4 py-1.5 font-mono text-[10.5px] text-[color:var(--ze-accent,#4fd1c5)]">
            {describe(active.tool)}
          </div>
        )}

        <div className="ze-scroll max-h-[46vh] overflow-y-auto">
          {!q && (
            <div className="px-4 py-3">
              <div className="mb-2 text-[10.5px] uppercase tracking-wide text-[color:var(--ze-text-faint)]">
                Try
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((sug) => (
                  <button
                    key={sug}
                    className="ze-btn !px-2.5 !py-1 !text-[11px]"
                    onClick={() => setQ(sug)}
                  >
                    {sug}
                  </button>
                ))}
              </div>
              <div className="mt-3 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
                Resolved locally against the catalogue, with no model call: the
                answer is the same offline, and the queries never leave this
                machine.
              </div>
            </div>
          )}

          {q && !list.length && (
            <div className="px-4 py-4 text-[11.5px] text-[color:var(--ze-text-dim)]">
              Nothing matched. This resolves a fixed vocabulary &mdash; regions,
              variables, depths, dates, assessment layers, instrument ids &mdash;
              rather than guessing.
            </div>
          )}

          {list.map((r, i) => (
            <button
              key={`${r.tool.name}-${i}`}
              className="ze-row w-full justify-between"
              data-active={i === cursor ? "true" : "false"}
              onMouseEnter={() => setCursor(i)}
              onClick={() => void run(r.tool)}
            >
              <span className="truncate text-left">{r.label}</span>
              <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-[color:var(--ze-text-faint)]">
                {r.group}
              </span>
            </button>
          ))}

          {busy && (
            <div className="px-4 py-3 text-[11.5px] text-[color:var(--ze-text-dim)]">
              matching every cycle against the model&hellip;
            </div>
          )}

          {rows && !busy && (
            <div className="border-t border-[color:var(--ze-line)] px-4 py-2.5">
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-[color:var(--ze-text-faint)]">
                ranked by {ranking.replace(/_/g, " ")} &mdash; computed on the
                observation index
              </div>
              {!rows.length && (
                <div className="text-[11.5px] text-[color:var(--ze-text-dim)]">
                  No instrument in this catalogue could be ranked that way.
                </div>
              )}
              {rows.map((r) => (
                <button
                  key={r.instrument}
                  className="ze-row w-full justify-between !px-0"
                  onClick={() => void openProfile(r.platform, r.lastProfileId).then(onClose)}
                >
                  <span className="truncate text-left font-mono text-[11px]">
                    {r.instrument}
                  </span>
                  <span className="ml-2 shrink-0 text-[10.5px] text-[color:var(--ze-text-dim)]">
                    {ranking === "trajectory_length" && `${Math.round(r.trajectoryKm)} km`}
                    {ranking === "model_error" &&
                      (r.rmse === null ? "--" : `RMSE ${r.rmse.toFixed(2)}`)}
                    {ranking === "recency" && r.last.slice(0, 10)}
                    {ranking === "profile_count" && `${r.profiles} profiles`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
