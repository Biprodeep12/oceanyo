"use client";

// Customizable colorbar: palette, min/max, log/linear.
//
// The settings drive the map tiles (as query parameters on the tile URL) and
// the volume shader (as uniforms) from the SAME store value, so a tile and the
// water column beneath it are never coloured differently. A mismatch there
// reads as a data bug to anyone looking at the screen.

import { useEffect, useState } from "react";
import { colormapNames, cssGradient } from "@/lib/color/colormaps";
import { useSessionStore } from "@/state/useSessionStore";
import { useDisplaySettings } from "@/state/useDisplaySettings";

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
    <label className="flex flex-1 flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-slate-500">{label}</span>
      <input
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-[11px] text-slate-100"
      />
    </label>
  );
}

export default function ColorbarEditor() {
  const variable = useSessionStore((s) => s.variable);
  const meta = useSessionStore((s) => s.variables.find((v) => v.variable === s.variable));
  const display = useDisplaySettings();
  const setColorRange = useSessionStore((s) => s.setColorRange);
  const setLogScale = useSessionStore((s) => s.setLogScale);
  const setColormap = useSessionStore((s) => s.setColormap);
  const [open, setOpen] = useState(false);

  if (!meta) return null;
  const [lo, hi] = display.range;

  return (
    <div>
      <div
        className="h-2 w-full cursor-pointer rounded"
        style={{ background: cssGradient(display.colormap) }}
        onClick={() => setOpen((v) => !v)}
        title="Click to edit the colour scale"
      />
      <div className="mt-0.5 flex items-center justify-between font-mono text-[9px] text-slate-500">
        <span>{lo}</span>
        <span>
          {meta.units}
          {display.log ? " · log" : ""}
        </span>
        <span>{hi}</span>
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        className="mt-1 w-full rounded border border-slate-700/70 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      >
        {open ? "Hide colour scale" : "Edit colour scale"}
        {display.customised && !open ? " ·" : ""}
      </button>

      {open && (
        <div className="mt-1.5 space-y-2 rounded border border-slate-700/50 bg-slate-950/60 p-2">
          <div className="flex gap-1.5">
            <NumberField label="min" value={lo} onCommit={(v) => setColorRange(variable, [v, hi])} />
            <NumberField label="max" value={hi} onCommit={(v) => setColorRange(variable, [lo, v])} />
          </div>

          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-slate-500">palette</span>
            <select
              value={display.colormap}
              onChange={(e) => setColormap(variable, e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[11px] text-slate-100"
            >
              {colormapNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-300">
            <input
              type="checkbox"
              checked={display.log}
              onChange={(e) => setLogScale(variable, e.target.checked)}
              className="accent-teal-400"
            />
            logarithmic
          </label>

          <button
            onClick={() => {
              setColorRange(variable, null);
              setLogScale(variable, null);
              setColormap(variable, null);
            }}
            disabled={!display.customised}
            className="w-full rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset to {meta.validRange[0]} .. {meta.validRange[1]}
          </button>
        </div>
      )}
    </div>
  );
}
