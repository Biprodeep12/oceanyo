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
// A model is called only for phrases the lookup table cannot parse, and only
// when one is configured. See lib/nlq/tools.ts for why the deterministic
// resolver is the default path rather than the backstop, and the tool calls a
// model returns are validated server-side before they ever reach this list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { IconSearch } from "@/components/ui/icons";
import { api } from "@/lib/api/client";
import { openProfile } from "@/lib/api/openProfile";
import { describe, resolve, type Resolution, type Tool } from "@/lib/nlq/tools";
import type { QueryResponse } from "@/lib/api/types";
import { applyAction } from "@/lib/nlq/applyAction";
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
  // What the model proposed, if it was asked. Kept separate from the local
  // results so the two are never confused in the list or in the mind.
  const [asked, setAsked] = useState<QueryResponse | null>(null);
  const [asking, setAsking] = useState(false);
  // Seconds spent waiting. A free tier queues its first call -- measured 33 s
  // cold -- and a spinner with no number is indistinguishable from a hang.
  const [waited, setWaited] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const presets = useSessionStore((s) => s.presets);
  const variables = useSessionStore((s) => s.variables);
  const times = useSessionStore((s) => s.times);
  const observations = useSessionStore((s) => s.observations);
  const nlqReady = useSessionStore((s) => s.health?.nlq ?? false);

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

  // The model is asked ONLY when the lookup table found nothing.
  //
  // Not a fallback bolted on for when the network fails -- the other way
  // round. A phrase the table matches is resolved offline, for free, in
  // microseconds, and identically every time; sending it to a model as well
  // would be slower, less reliable, and would put a ministry's queries through
  // a third-party endpoint for no gain. What the model adds is the phrasing
  // the table cannot anticipate, which is exactly where spec 5.2 argues
  // natural language earns its place.
  useEffect(() => {
    if (!open || !nlqReady) return;
    const phrase = q.trim();
    // Short fragments are someone still typing, not a question.
    if (results.length || phrase.length < 8) return;
    const ac = new AbortController();
    // Long enough that typing a sentence is one request rather than thirty.
    const t = setTimeout(() => {
      setAsking(true);
      setWaited(0);
      api
        .query(phrase, ac.signal)
        .then(setAsked)
        .catch((e) => {
          if ((e as Error).name !== "AbortError") console.warn("query:", e);
        })
        .finally(() => setAsking(false));
    }, 650);
    return () => {
      clearTimeout(t);
      ac.abort();
      // The pending request is being abandoned, so the waiting state it owns
      // goes with it. Clearing this at the TOP of the effect instead wrote
      // state during the commit React was already running.
      setAsking(false);
    };
  }, [q, open, nlqReady, results.length]);

  // One list, with the model's suggestions after the local ones. Ordering is
  // the claim: what the platform is certain of comes first.
  const modelResults: Resolution[] = useMemo(
    () =>
      (asked?.tools ?? []).map((t) => ({
        tool: t as unknown as Tool,
        label: describe(t as unknown as Tool),
        score: 0,
        group: "Model" as Resolution["group"],
      })),
    [asked],
  );

  // Reset where the value changes -- in the input handler -- rather than in an
  // effect that watches it. Same result, one render instead of two.
  const onQueryChange = (next: string) => {
    setQ(next);
    setCursor(0);
    setAsked(null);
  };

  useEffect(() => {
    if (!asking) return;
    const id = window.setInterval(() => setWaited((w) => w + 1), 1000);
    return () => window.clearInterval(id);
  }, [asking]);
  useEffect(() => {
    if (open) {
      setQ("");
      setRows(null);
      setRanking("");
      setAsked(null);
      // rAF, not a bare focus(): the element is being revealed in the same
      // commit and is not yet focusable when the effect runs.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const run = useCallback(
    async (tool: Tool) => {
      switch (tool.name) {
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
              variable: useSessionStore.getState().variable,
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
        default:
          // One executor, shared with the assistant. Two copies of "what
          // set_time means" drift the moment one of them gains a case, and the
          // symptom is the assistant moving the display differently from the
          // search box.
          applyAction(tool as unknown as { name: string; args: Record<string, unknown> });
          onClose();
      }
    },
    [onClose],
  );

  // --- keyboard ---
  const list: Resolution[] = useMemo(
    () => [...results, ...modelResults],
    [results, modelResults],
  );
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
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="a region, a variable, a depth, or a question about the floats"
            className="w-full bg-transparent text-[13px] text-[color:var(--ze-text)] outline-none placeholder:text-[color:var(--ze-text-faint)]"
            data-testid="palette-input"
          />
          <kbd className="ze-kbd">esc</kbd>
        </div>

        {/* The resolved tool call, before anything runs. */}
        {active && (
          <div className="border-b border-[color:var(--ze-line)] bg-[color:var(--ze-inset)] px-4 py-1.5 font-mono text-[10.5px] text-[color:var(--ze-accent,#4fd1c5)]">
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
                    onClick={() => onQueryChange(sug)}
                  >
                    {sug}
                  </button>
                ))}
              </div>
              <div className="mt-3 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
                {nlqReady ? (
                  <>
                    Resolved locally against the catalogue first. Only a phrase
                    the lookup table cannot parse is sent to a model, and it can
                    emit tool calls and nothing else &mdash; every result you
                    see is computed by this API.
                  </>
                ) : (
                  <>
                    Resolved locally against the catalogue, with no model call:
                    the answer is the same offline, and the queries never leave
                    this machine.
                  </>
                )}
              </div>
            </div>
          )}

          {q && !list.length && !asking && (
            <div className="px-4 py-4 text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
              Nothing matched. This resolves a fixed vocabulary &mdash; regions,
              variables, depths, dates, assessment layers, instrument ids &mdash;
              rather than guessing.
              {asked?.source === "model" && asked.tools.length === 0 && (
                <div className="mt-1.5 text-[color:var(--ze-text-faint)]">
                  {asked.model} was asked and proposed nothing this catalogue
                  can do
                  {asked.rejected ? `; ${asked.rejected} call(s) were rejected` : ""}.
                </div>
              )}
              {asked?.source === "error" && (
                <div className="mt-1.5 text-[color:var(--ze-warn)]">
                  {asked.model}: {asked.reason}
                </div>
              )}
            </div>
          )}

          {asking && (
            <div className="px-4 py-3 text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
              asking the model to name a tool&hellip; {waited}s
              {waited > 8 && (
                <div className="mt-1 text-[10.5px] text-[color:var(--ze-text-faint)]">
                  the first call of a session queues on a free tier; everything
                  the lookup table can answer is instant
                </div>
              )}
            </div>
          )}

          {list.map((r, i) => (
            <button
              key={`${r.tool.name}-${i}`}
              className="ze-row ze-row-fill justify-between"
              data-active={i === cursor ? "true" : "false"}
              onMouseEnter={() => setCursor(i)}
              onClick={() => void run(r.tool)}
            >
              <span className="truncate text-left">{r.label}</span>
              <span
                className="ml-2 shrink-0 text-[10px] uppercase tracking-wide"
                style={{
                  // A row a model proposed is marked as one. Presenting an
                  // interpretation and a lookup identically would be the one
                  // thing 5.2 asks this feature not to do.
                  color:
                    r.group === "Model"
                      ? "var(--ze-accent, #4fd1c5)"
                      : "var(--ze-text-faint)",
                }}
              >
                {r.group}
              </span>
            </button>
          ))}

          {asked?.source === "model" && asked.tools.length > 0 && (
            <div className="px-4 pb-2 pt-1 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
              interpreted by {asked.model} in {asked.latencyMs} ms &middot; the
              call runs only when you choose it
            </div>
          )}

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
                  className="ze-row ze-row-fill justify-between !px-0"
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
