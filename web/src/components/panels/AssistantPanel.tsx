"use client";

// The assistant, and the line it must not blur.
//
// Spec 5.2: "If the layer ever explains rather than navigates, measured values
// and generated interpretation must be visually separated. The scientific
// credibility built by the matchup metrics is easy to lose here."
//
// So this panel renders four kinds of thing four different ways:
//
//   * what it is DOING, live -- each tool call as it is made. A question costs
//     18-70 s because every round is a trip to a free-tier model, and twenty
//     seconds of an unchanging spinner is indistinguishable from a hang.
//   * what the tools MEASURED -- monospace, boxed, labelled with the tool.
//   * what the assistant WROTE -- ordinary prose, marked as generated.
//   * what it CHANGED -- the view actions it applied, listed, because a display
//     that moves on its own is alarming unless it says why.
//
// And one more, learned the hard way: the very first question this endpoint
// was asked came back quoting a spatial mean of 32.565 degC when the reading
// said 28.751. The server now checks every number in the prose against every
// number in the readings, and anything untraceable is marked here in warning
// colour. A confident sentence gets read; a JSON block underneath does not.

import { useEffect, useMemo, useRef, useState } from "react";

import { IconClose, IconSparkle } from "@/components/ui/icons";
import { api } from "@/lib/api/client";
import type { ChatResponse, ChatView } from "@/lib/api/types";
import { applyAction } from "@/lib/nlq/applyAction";
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
};

const doingLabel = (name: string) =>
  DOING[name] ?? (name.startsWith("view_") ? "moving the display" : name);

function Reading({ tool, result }: { tool: string; result: unknown }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => JSON.stringify(result, null, 1), [result]);
  const long = text.length > 300;
  return (
    <div className="ze-reading">
      <div className="flex items-center justify-between gap-2 px-2.5 pt-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-[color:var(--ze-accent)]">
          measured &middot; {tool}
        </span>
        {long && (
          <button
            className="shrink-0 text-[9.5px] text-[color:var(--ze-text-faint)] hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "less" : "more"}
          </button>
        )}
      </div>
      <pre className="ze-scroll max-h-[190px] overflow-auto px-2.5 pb-2 pt-1 font-mono text-[10px] leading-snug text-[color:var(--ze-text-dim)]">
        {long && !open ? `${text.slice(0, 300)}…` : text}
      </pre>
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
          if (e.type === "tool") setDoing((d) => [...d, doingLabel(e.name)]);
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
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {t.meta.actions.map((a, j) => (
                      <span key={j} className="ze-tool-chip">
                        {a.name}
                        {a.args && Object.keys(a.args).length
                          ? `(${Object.values(a.args).join(", ")})`
                          : "()"}
                      </span>
                    ))}
                  </div>
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
                  <Reading key={j} tool={r.tool} result={r.result} />
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
