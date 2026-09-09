"use client";

// Bottom-centre time control, in Zoom Earth's shape: play, the date, and a
// stepper you can nudge without aiming at a 4px scrubber handle.
//
// The steppers move whole model steps rather than clock hours. The synthetic
// catalog is daily, and inventing an hour control that snaps back to the
// nearest day would be a lie about the resolution of the data.

import { useEffect } from "react";

import {
  IconChevronDown,
  IconChevronUp,
  IconPause,
  IconPlay,
  IconSkipEnd,
} from "@/components/ui/icons";
import { useSessionStore } from "@/state/useSessionStore";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function Stepper({
  value,
  onUp,
  onDown,
  label,
}: {
  value: string;
  onUp: () => void;
  onDown: () => void;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center">
      <button
        onClick={onUp}
        aria-label={`Next ${label}`}
        className="grid h-4 w-7 place-items-center rounded text-[color:var(--ze-text-faint)] hover:text-white"
      >
        <IconChevronUp className="h-3.5 w-3.5" />
      </button>
      <span className="font-mono text-[17px] leading-5 tracking-tight text-[color:var(--ze-text)]">
        {value}
      </span>
      <button
        onClick={onDown}
        aria-label={`Previous ${label}`}
        className="grid h-4 w-7 place-items-center rounded text-[color:var(--ze-text-faint)] hover:text-white"
      >
        <IconChevronDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function Timeline() {
  const times = useSessionStore((s) => s.times);
  const timeIndex = useSessionStore((s) => s.timeIndex);
  const playing = useSessionStore((s) => s.playing);
  const setTimeIndex = useSessionStore((s) => s.setTimeIndex);
  const toggle = useSessionStore((s) => s.toggle);
  const bufferedTimes = useSessionStore((s) => s.bufferedTimes);

  // Playback lives here, next to the control that starts it.
  useEffect(() => {
    if (!playing || times.length < 2) return;
    const id = window.setInterval(() => {
      const st = useSessionStore.getState();
      st.setTimeIndex((st.timeIndex + 1) % st.times.length);
    }, 420);
    return () => window.clearInterval(id);
  }, [playing, times.length]);

  const iso = times[Math.min(timeIndex, times.length - 1)];
  const when = iso ? new Date(iso) : null;
  const day = when ? String(when.getUTCDate()) : "--";
  const month = when ? MONTHS[when.getUTCMonth()] : "";
  // Zoom Earth steps hours because its models are sub-daily. This catalog is
  // daily, so an hh:mm pair would read 00:00 forever and both chevrons would
  // silently move a whole day. The step index is what actually changes.
  const stepNo = times.length ? String(timeIndex + 1).padStart(2, "0") : "--";
  const total = times.length ? String(times.length).padStart(2, "0") : "--";

  const step = (delta: number) =>
    setTimeIndex(Math.min(times.length - 1, Math.max(0, timeIndex + delta)));

  const progress = times.length > 1 ? timeIndex / (times.length - 1) : 0;

  // Which steps are already decoded and on the GPU (spec 5.1 item 7). Showing
  // it is the difference between "the timeline is stuttering" and "the
  // timeline has not buffered that far yet" -- the same reason a video
  // scrubber shows its buffer.
  const buffered = new Set(bufferedTimes);

  return (
    <div className="ze-panel pointer-events-auto relative flex flex-1 items-stretch justify-center gap-1 overflow-hidden pl-1 pr-2 md:flex-none">
      <button
        onClick={() => toggle("playing")}
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
        className="grid w-11 place-items-center rounded-xl text-[color:var(--ze-text)] hover:bg-white/10"
      >
        {playing ? <IconPause className="h-6 w-6" /> : <IconPlay className="h-6 w-6" />}
      </button>

      <div className="flex items-center gap-3 py-2">
        <div className="flex flex-col items-center">
          <div className="h-4" />
          <span className="whitespace-nowrap text-[17px] font-semibold leading-5 text-[color:var(--ze-text)]">
            {day} {month}
          </span>
          <div className="h-4" />
        </div>

        <Stepper value={stepNo} onUp={() => step(1)} onDown={() => step(-1)} label="step" />
        <div className="flex flex-col items-center">
          <div className="h-4" />
          <span className="font-mono text-[15px] leading-5 text-[color:var(--ze-text-faint)]">
            /{total}
          </span>
          <div className="h-4" />
        </div>
      </div>

      <button
        onClick={() => setTimeIndex(Math.max(0, times.length - 1))}
        aria-label="Jump to the last step"
        title="Jump to the last step"
        className="hidden w-9 place-items-center rounded-xl text-[color:var(--ze-text-dim)] hover:bg-white/10 hover:text-white sm:grid"
      >
        <IconSkipEnd className="h-4 w-4" />
      </button>

      {/* Hairline scrubber: the whole run at a glance, and draggable. */}
      <input
        type="range"
        aria-label="Time step"
        min={0}
        max={Math.max(times.length - 1, 0)}
        step={1}
        value={timeIndex}
        onChange={(e) => setTimeIndex(Number(e.target.value))}
        className="absolute inset-x-0 bottom-0 h-1 w-full cursor-pointer appearance-none bg-transparent opacity-0"
        style={{ height: 10 }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]"
        style={{ background: "rgba(255,255,255,0.10)" }}
      >
        {times.map((t, i) =>
          buffered.has(t) ? (
            <span
              key={t}
              className="absolute top-0 h-full"
              style={{
                left: `${(i / Math.max(times.length - 1, 1)) * 100}%`,
                width: `${100 / Math.max(times.length - 1, 1)}%`,
                background: "rgba(255,255,255,0.30)",
              }}
            />
          ) : null,
        )}
        <div
          className="absolute top-0 h-full"
          style={{ width: `${progress * 100}%`, background: "var(--ze-accent)" }}
        />
      </div>
    </div>
  );
}
