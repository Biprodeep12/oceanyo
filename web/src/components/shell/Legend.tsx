"use client";

// Bottom-left colour legend, and the editor behind it.
//
// Zoom Earth puts its precipitation scale flat against the bottom-left corner
// and nothing else; the same place works here because the scale is the one
// piece of chrome you read while looking at the map rather than at the panel.
// Clicking it opens the editor, so the control lives where its effect is.

import { useEffect, useRef, useState } from "react";

import { colormapNames, cssGradient } from "@/lib/color/colormaps";
import { useDisplaySettings } from "@/state/useDisplaySettings";
import { currentVariable, useSessionStore } from "@/state/useSessionStore";

function NumberField({
  value,
  onCommit,
  label,
}: {
  value: number;
  onCommit: (v: number) => void;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  // Follow external changes (variable switch, reset) but do not fight typing.
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n)) onCommit(n);
    else setText(String(value));
  };

  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[9.5px] uppercase tracking-wider text-[color:var(--ze-text-faint)]">
        {label}
      </span>
      <input
        type="number"
        className="ze-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/**
 * Colour-bar end labels.
 *
 * The range now comes from the DATA rather than from a round validity range,
 * so it arrives as 2.453998565673828 rather than -2. Three significant figures
 * is what a colour bar can actually resolve, and a bar labelled with sixteen
 * digits reads as a bug in the units.
 */
function tick(v: number): string {
  if (!Number.isFinite(v)) return "--";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

export default function Legend() {
  const variable = useSessionStore((s) => s.variable);
  const meta = useSessionStore(currentVariable);
  const showAnomaly = useSessionStore((s) => s.showAnomaly);
  const anomalyLimit = useSessionStore((s) => s.anomalyLimit);
  const phase = useSessionStore((s) => s.phase);
  const display = useDisplaySettings();
  const setColorRange = useSessionStore((s) => s.setColorRange);
  const setLogScale = useSessionStore((s) => s.setLogScale);
  const setColormap = useSessionStore((s) => s.setColormap);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!meta) return null;

  // The anomaly overlay replaces what the map is coloured by, so it must
  // replace the legend too -- a thermal ramp under a diverging layer would
  // misreport every pixel on screen.
  const anomalyActive = showAnomaly && phase !== "block";
  const [lo, hi] = anomalyActive ? [-anomalyLimit, anomalyLimit] : display.range;
  const ramp = anomalyActive ? "delta" : display.colormap;
  const unit = anomalyActive ? "sigma vs climatology" : meta.units;

  return (
    <div ref={box} className="pointer-events-auto relative">
      {open && !anomalyActive && (
        <div className="ze-panel absolute bottom-[54px] left-0 right-0 space-y-3 p-3.5 md:right-auto md:w-[248px]">
          <div className="ze-section-label !m-0 !p-0">Colour scale</div>
          <div className="flex gap-2">
            <NumberField label="min" value={lo} onCommit={(v) => setColorRange(variable, [v, hi])} />
            <NumberField label="max" value={hi} onCommit={(v) => setColorRange(variable, [lo, v])} />
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[9.5px] uppercase tracking-wider text-[color:var(--ze-text-faint)]">
              palette
            </span>
            <select
              value={display.colormap}
              onChange={(e) => setColormap(variable, e.target.value)}
              className="ze-input"
              aria-label="Palette"
            >
              {colormapNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[color:var(--ze-text-dim)]">
            <input
              type="checkbox"
              checked={display.log}
              onChange={(e) => setLogScale(variable, e.target.checked)}
              className="accent-[color:var(--ze-accent)]"
            />
            logarithmic
          </label>
          <button
            className="ze-btn w-full"
            onClick={() => {
              setColorRange(variable, null);
              setLogScale(variable, null);
              setColormap(variable, null);
            }}
            disabled={!display.customised}
          >
            Reset to {meta.validRange[0]} .. {meta.validRange[1]}
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        disabled={anomalyActive}
        aria-label={open ? "Hide colour scale" : "Edit colour scale"}
        title={
          anomalyActive
            ? "The anomaly layer sets its own scale"
            : "Edit colour scale"
        }
        className="block w-full cursor-pointer text-left disabled:cursor-default md:w-[268px]"
      >
        <div
          className="h-[13px] w-full rounded-[3px]"
          style={{ background: cssGradient(ramp), boxShadow: "var(--ze-shadow)" }}
        />
        <div className="mt-1 flex items-baseline justify-between">
          <span className="ze-overlay-text font-mono">{tick(lo)}</span>
          <span className="ze-overlay-text">
            {unit}
            {!anomalyActive && display.log ? " · log" : ""}
            {!anomalyActive && display.customised ? " ·" : ""}
          </span>
          <span className="ze-overlay-text font-mono">{tick(hi)}</span>
        </div>
      </button>
    </div>
  );
}
