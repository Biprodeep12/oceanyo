"use client";

// The assistant, and the line it must not blur.
//
// Spec 5.2: "If the layer ever explains rather than navigates, measured values
// and generated interpretation must be visually separated. The scientific
// credibility built by the matchup metrics is easy to lose here."
//
// So this panel renders four kinds of thing four different ways:
//
//   * what it is DOING, live -- each tool call as it is made, named. A question
//     costs 18-70 s because every round is a trip to a free-tier model, and
//     twenty seconds of an unchanging spinner is indistinguishable from a hang.
//   * what the tools MEASURED -- boxed and labelled with the tool, read out as
//     a headline and labelled figures rather than as the JSON that came back.
//     The JSON is one click underneath and is still the authority; a reader who
//     has to find the one number in eighteen lines of arrays stops checking.
//   * what the assistant WROTE -- ordinary prose, marked as generated.
//   * what it CHANGED -- the view actions it applied, in words, because a
//     display that moves on its own is alarming unless it says why.
//
// And one more, learned the hard way: the very first question this endpoint
// was asked came back quoting a spatial mean of 32.565 degC when the reading
// said 28.751. The server now checks every number in the prose against every
// number in the readings, and anything untraceable is marked here in warning
// colour. A confident sentence gets read; a JSON block underneath does not.

import { useEffect, useMemo, useRef, useState } from "react";

import { IconClose, IconSparkle } from "@/components/ui/icons";
import { api } from "@/lib/api/client";
import type { ChatResponse, ChatView, RegionPreset } from "@/lib/api/types";
import { applyAction, describeAction } from "@/lib/nlq/applyAction";
import { describeReading } from "@/lib/nlq/describeReading";
import { useIsMobile } from "@/state/useMediaQuery";
import { currentTime, useSessionStore } from "@/state/useSessionStore";

interface Turn {
  role: "user" | "assistant";
  content: string;
  meta?: ChatResponse;
}

const STARTERS = [
  "When was the surface warmest, and take me there",
  "How well observed is this region?",
  "Which float disagrees most with the model?",
  "What is this dataset, exactly?",
];

/** Tool name -> what it is doing, in words rather than in an identifier. */
const DOING: Record<string, string> = {
  read_timeseries: "reading every timestep",
  read_value: "reading the value at a point",
  read_assessment: "measuring coverage and model error",
  read_events: "scanning for extremes against the climatology",
  read_instruments: "ranking the instruments",
  read_profile: "comparing a float against the model",
  read_catalog: "checking what this dataset is",
  // The view_ tools, named one by one rather than all as "moving the display".
  // The dive in particular: it replaces the map with a 3D block, and someone
  // watching a progress list has a right to know that is coming before the
  // screen does it.
  view_dive: "diving into the 3D block",
  view_select_preset: "moving to a named region",
  view_select_region: "selecting a region",
  view_set_variable: "switching the field on display",
  view_set_depth: "moving the depth slider",
  view_set_time: "jumping to a timestep",
  view_set_layer: "turning on an assessment layer",
  view_focus_platform: "opening an instrument",
};

/** The live line, with the argument in it when the argument is the point. */
function doingLabel(name: string, args: Record<string, unknown> = {}): string {
  const base = DOING[name] ?? (name.startsWith("view_") ? "moving the display" : name);
  if (name === "view_set_time" && args.time) {
    return `jumping to ${String(args.time).slice(0, 10)}`;
  }
  if (name === "view_set_depth" && args.depth !== undefined) {
    return `moving to ${args.depth} m`;
  }
  if (name === "view_focus_platform" && args.id) return `opening ${args.id}`;
  if (name === "read_profile" && args.instrument) {
    return `comparing ${args.instrument} against the model`;
  }
  return base;
}

/**
 * One tool reading: what it found, with the JSON it found it in underneath.
 *
 * The raw result is collapsed rather than dropped. It is the thing the
 * assistant's numbers are checked against, so it has to stay reachable -- but
 * it is evidence for a dispute, not the first thing to read.
 */
function Reading({ tool, args, result }: { tool: string; args: Record<string, unknown>; result: unknown }) {
  const [raw, setRaw] = useState(false);
  const summary = useMemo(() => describeReading(tool, args, result), [tool, args, result]);
  // Serialised only once it is asked for. read_timeseries carries four arrays
  // the length of the record, and stringifying every reading of every turn to
  // fill a block that is closed by default is work for nothing.
  const text = useMemo(
    () => (raw ? JSON.stringify(result, null, 1) : ""),
    [raw, result],
  );

  return (
    <div className="ze-reading">
      <div className="flex items-center justify-between gap-2 px-2.5 pt-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-[color:var(--ze-accent)]">
          measured &middot; {tool}
        </span>
        <button
          type="button"
          className="shrink-0 text-[9.5px] text-[color:var(--ze-text-faint)] hover:underline"
          onClick={() => setRaw((v) => !v)}
          title={raw ? "Hide the raw tool result" : "Show the raw tool result"}
        >
          {raw ? "hide data" : "show data"}
        </button>
      </div>

      <div className="px-2.5 pb-2 pt-1">
        <div className="text-[11px] leading-snug text-[color:var(--ze-text-dim)]">
          {summary.headline}
        </div>
        {summary.facts.length > 0 && (
          <dl className="mt-1.5 space-y-[3px]">
            {summary.facts.map((f, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-[10px] text-[color:var(--ze-text-faint)]">
                  {f.label}
                </dt>
                <dd className="min-w-0 break-words text-right font-mono text-[10.5px] text-[color:var(--ze-text)]">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {summary.note && (
          <div className="mt-1.5 text-[9.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
            {summary.note}
          </div>
        )}
      </div>

      {raw && (
        <pre className="ze-scroll max-h-[190px] overflow-auto border-t border-[color:var(--ze-line)] px-2.5 py-1.5 font-mono text-[10px] leading-snug text-[color:var(--ze-text-dim)]">
          {text}
        </pre>
      )}
    </div>
  );
}

/** The view changes, listed in words, with the literal call in the tooltip. */
function Applied({
  actions,
  presets,
}: {
  actions: { name: string; args: Record<string, unknown> }[];
  presets: RegionPreset[];
}) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-1">
      {actions.map((a, j) => (
        <span
          key={j}
          className="ze-tool-chip ze-tool-chip-said"
          title={`${a.name}(${Object.entries(a.args ?? {})
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")})`}
          style={
            a.name === "dive"
              ? { background: "var(--ze-accent-soft)", borderColor: "var(--ze-accent)", color: "var(--ze-accent-fg)" }
              : undefined
          }
        >
          {a.name === "dive" ? "⬇ " : ""}
          {describeAction(a, presets)}
        </span>
      ))}
    </div>
  );
}

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(0);
  const [doing, setDoing] = useState<string[]>([]);
  const mobile = useIsMobile();
  const ready = useSessionStore((s) => s.health?.nlq ?? false);
  // Only so an applied `select_preset` can be named rather than listed by id.
  const presets = useSessionStore((s) => s.presets);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, doing, busy]);

  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setWaited((w) => w + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // Abandon an in-flight conversation when the panel closes, rather than
  // leaving a request running against a component that no longer exists.
  useEffect(() => () => abortRef.current?.abort(), []);

  /** What the user is looking at, so "here" and "now" mean something. */
  const viewState = (): ChatView => {
    const s = useSessionStore.getState();
    return {
      variable: s.variable,
      time: currentTime(s),
      depth: s.depth,
      bbox: s.selection ?? undefined,
      mode: s.phase === "block" || s.phase === "holding" ? "3D block" : "map",
      profile: s.selectedProfile
        ? `${s.selectedProfile.platform} ${s.selectedProfile.id}`
        : undefined,
    };
  };

  const send = async (text: string) => {
    const phrase = text.trim();
    if (!phrase || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: phrase }];
    setTurns(next);
    setDraft("");
    setWaited(0);
    setDoing([]);
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await api.chatStream(
        next.map((t) => ({ role: t.role, content: t.content })),
        viewState(),
        (e) => {
          if (e.type === "tool") setDoing((d) => [...d, doingLabel(e.name, e.args)]);
        },
        ac.signal,
      );
      if (!r) throw new Error("the conversation ended without an answer");
      setTurns([
        ...next,
        { role: "assistant", content: r.reply || r.error || "", meta: r },
      ]);
      // Applied AFTER the answer is on screen, so the display moving is
      // explained by text the user has already seen rather than happening
      // first and needing to be accounted for afterwards.
      for (const a of r.actions ?? []) applyAction(a);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setTurns(next);
      } else {
        setTurns([
          ...next,
          { role: "assistant", content: `Could not reach the assistant: ${e}` },
        ]);
      }
    } finally {
      setBusy(false);
      setDoing([]);
      abortRef.current = null;
    }
  };

  return (
    <div className={mobile ? "ze-side-panel ze-side-panel-mobile" : "ze-side-panel"}>
      <header className="ze-side-head">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <IconSparkle className="h-3.5 w-3.5 text-[color:var(--ze-accent)]" />
            <span className="ze-side-title">Assistant</span>
          </div>
          <p className="ze-side-sub">
            {ready
              ? "Reads the data with tools, then answers. It cannot state a number it did not measure."
              : "No model configured. Set OCEANUPS_NLQ_API_KEY and restart the API."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {turns.length > 0 && !busy && (
            <button
              className="ze-side-action"
              onClick={() => setTurns([])}
              title="Start a new conversation"
            >
              Clear
            </button>
          )}
          <button onClick={onClose} aria-label="Close assistant" className="ze-side-close">
            <IconClose className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="ze-scroll flex-1 overflow-y-auto px-4 py-3">
        {/* An empty conversation is most of the panel's height. Filling it with
            four buttons at the top and nothing else made the panel look
            broken; saying what the thing can do, next to examples of it, is
            both more useful and the answer to the question a first-time user
            actually has. */}
        {!turns.length && (
          <div className="flex h-full flex-col justify-center gap-3 pb-6">
            <div>
              <div className="text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
                Ask about the data on screen. It has tools for the whole
                timeline, any point or region, the observing network and the
                model&rsquo;s error against the floats.
              </div>
              <div className="mt-1.5 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
                Every figure it gives you comes from one of those tools, shown
                underneath the answer. It will move the map or the timeline to
                what it is describing.
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  className="ze-btn justify-start !px-2.5 !py-1.5 text-left !text-[11.5px]"
                  onClick={() => void send(s)}
                  disabled={!ready}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} className="mb-3.5">
            {t.role === "user" ? (
              <div className="ze-bubble-user">{t.content}</div>
            ) : (
              <div>
                {!!t.meta?.actions?.length && (
                  <Applied actions={t.meta.actions} presets={presets} />
                )}

                <div className="text-[12.5px] leading-relaxed text-[color:var(--ze-text)]">
                  {t.content}
                </div>

                {!!t.meta?.unverified?.length && (
                  <div className="ze-warn-box">
                    {t.meta.unverified.length === 1 ? "The number " : "The numbers "}
                    <b>{t.meta.unverified.join(", ")}</b>{" "}
                    {t.meta.unverified.length === 1 ? "appears" : "appear"} in no
                    reading below. Treat as unverified &mdash; the measurements
                    are what the tools returned.
                  </div>
                )}

                {(t.meta?.readings ?? []).map((r, j) => (
                  <Reading key={j} tool={r.tool} args={r.args} result={r.result} />
                ))}

                {t.meta && (
                  <div className="mt-1.5 text-[9.5px] text-[color:var(--ze-text-faint)]">
                    generated text &middot; {t.meta.rounds} tool round
                    {t.meta.rounds === 1 ? "" : "s"} &middot;{" "}
                    {(t.meta.latencyMs / 1000).toFixed(1)} s
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
            {doing.length ? (
              <ul className="space-y-0.5">
                {doing.map((d, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <span
                      className={
                        i === doing.length - 1 ? "ze-dot ze-dot-live" : "ze-dot"
                      }
                    />
                    {d}
                  </li>
                ))}
              </ul>
            ) : (
              <span>thinking&hellip;</span>
            )}
            <div className="mt-1 text-[10.5px] text-[color:var(--ze-text-faint)]">
              {waited}s &middot; every tool round is a call to a free-tier model
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="ze-side-foot"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ready ? "Ask about what you are looking at…" : "No model configured"}
          disabled={!ready || busy}
          data-testid="assistant-input"
          className="w-full bg-transparent text-[12.5px] text-[color:var(--ze-text)] outline-none placeholder:text-[color:var(--ze-text-faint)]"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="ze-btn shrink-0 !px-3 !py-1 !text-[11px]"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!ready || !draft.trim()}
            className="ze-btn ze-btn-primary shrink-0 !px-3 !py-1 !text-[11px]"
          >
            Ask
          </button>
        )}
      </form>

      <div className="px-4 pb-2.5 text-[9.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
        Research and visualisation tool. Not a forecast or a warning system.
      </div>
    </div>
  );
}
