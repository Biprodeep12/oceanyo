"use client";

import { useEffect, useState } from "react";
import { cssGradient } from "@/lib/color/colormaps";
import { probeGpu, type GpuCaps } from "@/three/caps";
import { currentTime, currentVariable, useSessionStore } from "@/state/useSessionStore";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-800/80 px-3 py-2.5 last:border-b-0">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {title}
      </div>
      {children}
    </div>
  );
}

function Slider({
  value, min, max, step, onChange, label,
}: {
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; label: string;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-200">{value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-teal-400"
      />
    </div>
  );
}

function Toggle({
  checked, onChange, label,
}: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5 text-[11px] text-slate-300">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-teal-400" />
      {label}
    </label>
  );
}

export default function ControlPanel() {
  const s = useSessionStore();
  const varMeta = useSessionStore(currentVariable);
  const time = useSessionStore(currentTime);
  // Probed after mount, not during render. Branching on `typeof window` inside
  // render makes the server and first client render differ, which React 19
  // reports as a hydration mismatch and then re-renders the whole tree.
  const [caps, setCaps] = useState<GpuCaps | null>(null);
  useEffect(() => setCaps(probeGpu()), []);

  // Timeline playback.
  useEffect(() => {
    if (!s.playing || s.times.length < 2) return;
    const id = window.setInterval(() => {
      const st = useSessionStore.getState();
      st.setTimeIndex((st.timeIndex + 1) % st.times.length);
    }, 420);
    return () => window.clearInterval(id);
  }, [s.playing, s.times.length]);

  const depthMax = varMeta?.depthRange[1] ?? 2000;

  return (
    <div className="pointer-events-auto w-[236px] overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900/90 backdrop-blur">
      <Section title="Variable">
        <select
          value={s.variable}
          onChange={(e) => s.setVariable(e.target.value)}
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
        >
          {s.variables.map((v) => (
            <option key={v.variable} value={v.variable}>
              {v.longName}
            </option>
          ))}
        </select>
        {varMeta && (
          <div
            className="mt-2 h-2 w-full rounded"
            style={{ background: cssGradient(varMeta.colormap) }}
            title={`${varMeta.colormap} colormap`}
          />
        )}
        {varMeta && (
          <div className="mt-0.5 flex justify-between font-mono text-[9px] text-slate-500">
            <span>{varMeta.validRange[0]}</span>
            <span>{varMeta.units}</span>
            <span>{varMeta.validRange[1]}</span>
          </div>
        )}
      </Section>

      <Section title="Depth">
        <Slider
          label="metres" value={s.depth} min={0} max={Math.round(depthMax)}
          step={10} onChange={s.setDepth}
        />
      </Section>

      <Section title="Time">
        <div className="mb-1 font-mono text-[11px] text-slate-200">
          {time ? time.slice(0, 10) : "--"}
        </div>
        <input
          type="range" min={0} max={Math.max(s.times.length - 1, 0)} step={1}
          value={s.timeIndex}
          onChange={(e) => s.setTimeIndex(Number(e.target.value))}
          className="w-full accent-teal-400"
        />
        <div className="mt-1.5 flex gap-1">
          <button
            onClick={() => s.setTimeIndex(Math.max(0, s.timeIndex - 1))}
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            &#9664;
          </button>
          <button
            onClick={() => s.toggle("playing")}
            className="flex-1 rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800"
          >
            {s.playing ? "Pause" : "Play"}
          </button>
          <button
            onClick={() => s.setTimeIndex(Math.min(s.times.length - 1, s.timeIndex + 1))}
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            &#9654;
          </button>
        </div>
      </Section>

      {s.phase === "block" && (
        <>
          <Section title="Block">
            <Slider
              label="vertical exaggeration" value={s.exaggeration}
              min={1} max={10} step={1} onChange={s.setExaggeration}
            />
            <div className="mt-2">
              <Slider
                label="volume opacity" value={s.opacity}
                min={0.1} max={1} step={0.05} onChange={s.setOpacity}
              />
            </div>
          </Section>
          <Section title="Layers">
            <Toggle checked={s.showVolume} onChange={() => s.toggle("showVolume")} label="Volume" />
            <Toggle checked={s.showSlice} onChange={() => s.toggle("showSlice")} label="Depth plane" />
            <Toggle checked={s.showParticles} onChange={() => s.toggle("showParticles")} label="Currents" />
          </Section>
        </>
      )}

      {caps && (
        <Section title="Renderer">
          <div className="space-y-0.5 font-mono text-[9px] leading-relaxed text-slate-500">
            <div>
              tier <span className="text-slate-300">{caps.tier}</span>
              {caps.tier === "slices" && " (volume unsupported)"}
            </div>
            <div>MAX_3D_TEXTURE {caps.max3DTextureSize}</div>
            <div>ray steps {caps.steps.idle}/{caps.steps.moving}</div>
          </div>
        </Section>
      )}
    </div>
  );
}
