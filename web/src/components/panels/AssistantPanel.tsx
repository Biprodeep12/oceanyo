"use client";

// The assistant, and the line it must not blur.
//
// Spec 5.2: "If the layer ever explains rather than navigates, measured values
// and generated interpretation must be visually separated. The scientific
// credibility built by the matchup metrics is easy to lose here."
//
// So this panel renders three different kinds of thing three different ways:
//
//   * what the tools MEASURED -- monospace, on a panel, labelled with the tool
//     that produced it. This is data.
//   * what the assistant WROTE -- ordinary prose, marked as generated.
//   * what the assistant DID -- the view actions it applied, listed, because a
//     display that moves on its own is alarming unless it says why.
//
// And one more, learned the hard way: the very first question this endpoint
// was asked came back quoting a spatial mean of 32.565 degC when the reading
// said 28.751. The server now checks every number in the prose against every
// number in the readings, and anything untraceable is marked here in warning
// colour. A confident sentence gets read; a JSON block underneath does not.

import { useEffect, useRef, useState } from "react";

import { IconClose, IconSparkle } from "@/components/ui/icons";
import { api } from "@/lib/api/client";
import type { ChatResponse } from "@/lib/api/types";
import { applyAction } from "@/lib/nlq/applyAction";
import { useIsMobile } from "@/state/useMediaQuery";
import { useSessionStore } from "@/state/useSessionStore";

interface Turn {
  role: "user" | "assistant";
  content: string;
  meta?: ChatResponse;
}

const STARTERS = [
  "When was the surface warmest, and take me there",
  "How well observed is the Arabian Sea?",
  "Which float disagrees most with the model?",
  "What is this dataset, exactly?",
];

function Reading({ tool, result }: { tool: string; result: unknown }) {
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(result, null, 1);
  const short = text.length > 320 && !open ? `${text.slice(0, 320)}…` : text;
  return (
    <div className="mt-1.5 rounded-lg border border-[color:var(--ze-line)] bg-black/25">
      <div className="flex items-center justify-between px-2.5 pt-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-wide text-[color:var(--ze-accent,#4fd1c5)]">
          measured &middot; {tool}
        </span>
        {text.length > 320 && (
          <button
            className="text-[9.5px] text-[color:var(--ze-text-faint)] hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "less" : "more"}
          </button>
        )}
      </div>
      <pre className="ze-scroll max-h-[190px] overflow-auto px-2.5 pb-2 pt-1 font-mono text-[10px] leading-snug text-[color:var(--ze-text-dim)]">
        {short}
      </pre>
    </div>
  );
}

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(0);
  const mobile = useIsMobile();
  const ready = useSessionStore((s) => s.health?.nlq ?? false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  // The counter is reset in send(), where the wait begins, rather than here.
  // Resetting inside the effect writes state during the render React is
  // already committing, which cascades a second render for nothing.
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setWaited((w) => w + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const send = async (text: string) => {
    const phrase = text.trim();
    if (!phrase || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: phrase }];
    setTurns(next);
    setDraft("");
    setWaited(0);
    setBusy(true);
    try {
      const r = await api.chat(
        next.map((t) => ({ role: t.role, content: t.content })),
      );
      setTurns([
        ...next,
        { role: "assistant", content: r.reply || r.error || "", meta: r },
      ]);
      // Applied AFTER the answer is on screen, so the display moving is
      // explained by text the user has already seen rather than happening
      // first and needing to be accounted for afterwards.
      for (const a of r.actions ?? []) applyAction(a);
    } catch (e) {
      setTurns([
        ...next,
        { role: "assistant", content: `Could not reach the assistant: ${e}` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={
        mobile
          ? "ze-panel fixed inset-x-2 bottom-2 top-2 z-[60] flex flex-col"
          : "ze-panel fixed bottom-3 right-[62px] top-3 z-[60] flex w-[400px] flex-col"
      }
    >
      <div className="flex items-start justify-between border-b border-[color:var(--ze-line)] px-4 py-3">
        <div>
          <div className="ze-section-label !m-0 !p-0">Assistant</div>
          <div className="mt-0.5 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
            {ready
              ? "Reads the data with tools, then answers. It cannot state a number it did not measure."
              : "No model configured. Set OCEANUPS_NLQ_API_KEY and restart the API."}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close assistant"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--ze-text-dim)] hover:bg-white/10 hover:text-white"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="ze-scroll flex-1 overflow-y-auto px-4 py-3">
        {!turns.length && (
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
        )}

        {turns.map((t, i) => (
          <div key={i} className="mb-3">
            {t.role === "user" ? (
              <div className="ml-6 rounded-lg bg-[color:var(--ze-accent-soft)] px-3 py-1.5 text-[12px] text-[color:var(--ze-accent-fg)]">
                {t.content}
              </div>
            ) : (
              <div>
                {/* What it did, before what it said: the view has already
                    moved by the time this is read. */}
                {!!t.meta?.actions?.length && (
                  <div className="mb-1 flex flex-wrap gap-1">
                    {t.meta.actions.map((a, j) => (
                      <span
                        key={j}
                        className="rounded border border-[color:var(--ze-line)] px-1.5 py-0.5 font-mono text-[9.5px] text-[color:var(--ze-text-faint)]"
                      >
                        {a.name}
                        {a.args && Object.keys(a.args).length
                          ? `(${Object.values(a.args).join(", ")})`
                          : "()"}
                      </span>
                    ))}
                  </div>
                )}

                <div className="text-[12px] leading-relaxed text-[color:var(--ze-text)]">
                  {t.content}
                </div>

                {!!t.meta?.unverified?.length && (
                  <div className="mt-1.5 rounded-lg border border-[color:var(--ze-warn)] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[color:var(--ze-warn)]">
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
            reading the data&hellip; {waited}s
            {waited > 10 && (
              <div className="mt-1 text-[10.5px] text-[color:var(--ze-text-faint)]">
                each tool call is a round trip to a free-tier model; the first
                of a session queues
              </div>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="flex items-center gap-2 border-t border-[color:var(--ze-line)] px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ready ? "Ask about this dataset…" : "No model configured"}
          disabled={!ready || busy}
          data-testid="assistant-input"
          className="w-full bg-transparent text-[12.5px] text-[color:var(--ze-text)] outline-none placeholder:text-[color:var(--ze-text-faint)]"
        />
        <button
          type="submit"
          disabled={!ready || busy || !draft.trim()}
          className="ze-btn ze-btn-primary shrink-0 !px-3 !py-1 !text-[11px]"
        >
          Ask
        </button>
      </form>

      <div className="px-3 pb-2 text-[9.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
        Research and visualisation tool. Not a forecast or a warning system.
      </div>
    </div>
  );
}

export { IconSparkle };
