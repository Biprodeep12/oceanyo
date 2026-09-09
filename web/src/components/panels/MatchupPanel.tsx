"use client";

// The scientific differentiator, made visible.
//
// Shows the observed profile against the model interpolated onto the same
// depths, plus the standard validation statistics. Measured values only --
// nothing here is generated or inferred.

import { useMemo } from "react";
import { useSessionStore } from "@/state/useSessionStore";

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null;
  hint?: string;
}) {
  // Units are shown once beneath the row, not per tile: four columns of
  // "0.320 degrees_C" overflow a 268px panel and collide with each other.
  return (
    <div className="flex min-w-0 flex-col" title={hint}>
      <span className="text-[9px] uppercase tracking-wider text-slate-400">{label}</span>
      <span className="truncate font-mono text-[13px] text-slate-100">
        {value === null || value === undefined
          ? "--"
          : `${value >= 0 && label === "Bias" ? "+" : ""}${value.toFixed(3)}`}
      </span>
    </div>
  );
}

/** Depth-profile overlay: observation vs model, drawn as inline SVG. */
function ProfileChart() {
  const matchup = useSessionStore((s) => s.matchup);
  const profile = useSessionStore((s) => s.selectedProfile);

  const chart = useMemo(() => {
    if (!matchup || !matchup.obsDepths.length) return null;
    const pts = matchup.obsDepths.map((d, i) => ({
      depth: d,
      obs: matchup.obsValues[i],
      model: matchup.modelValues[i],
    }));
    const values = pts.flatMap((p) => [p.obs, p.model]).filter((v): v is number => v != null);
    if (!values.length) return null;

    const vMin = Math.min(...values);
    const vMax = Math.max(...values);
    const dMax = Math.max(...pts.map((p) => p.depth));
    const pad = (vMax - vMin) * 0.08 || 1;

    const W = 240;
    const H = 300;
    const L = 34;
    const T = 8;
    const x = (v: number) => L + ((v - (vMin - pad)) / (vMax - vMin + 2 * pad)) * (W - L - 8);
    const y = (d: number) => T + (d / dMax) * (H - T - 20);

    const line = (key: "obs" | "model") =>
      pts
        .filter((p) => p[key] != null)
        .map((p, i) => `${i === 0 ? "M" : "L"}${x(p[key] as number).toFixed(1)},${y(p.depth).toFixed(1)}`)
        .join(" ");

    return { W, H, L, T, x, y, vMin, vMax, dMax, obs: line("obs"), model: line("model") };
  }, [matchup]);

  if (!chart) return null;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(chart.dMax * f));

  return (
    <svg width={chart.W} height={chart.H} className="mt-1">
      {ticks.map((d) => (
        <g key={d}>
          <line
            x1={chart.L} x2={chart.W - 8} y1={chart.y(d)} y2={chart.y(d)}
            stroke="#1e3244" strokeWidth={1}
          />
          <text x={4} y={chart.y(d) + 3} fill="#64798c" fontSize={9} fontFamily="monospace">
            {d}
          </text>
        </g>
      ))}
      <text x={4} y={chart.H - 4} fill="#64798c" fontSize={9}>m</text>
      <path d={chart.model} fill="none" stroke="#4fd1c5" strokeWidth={1.8} opacity={0.95} />
      <path d={chart.obs} fill="none" stroke="#f0b429" strokeWidth={1.8} opacity={0.95} />
      <g transform={`translate(${chart.L + 4}, ${chart.H - 12})`}>
        <line x1={0} x2={14} y1={-3} y2={-3} stroke="#4fd1c5" strokeWidth={2} />
        <text x={18} y={0} fill="#8fa6b8" fontSize={9}>model</text>
        <line x1={58} x2={72} y1={-3} y2={-3} stroke="#f0b429" strokeWidth={2} />
        <text x={76} y={0} fill="#8fa6b8" fontSize={9}>
          {profile?.platform ?? "obs"}
        </text>
      </g>
    </svg>
  );
}

export default function MatchupPanel() {
  const matchup = useSessionStore((s) => s.matchup);
  const profile = useSessionStore((s) => s.selectedProfile);
  const loading = useSessionStore((s) => s.loadingProfile);
  const setSelectedProfile = useSessionStore((s) => s.setSelectedProfile);
  const setMatchup = useSessionStore((s) => s.setMatchup);
  const varMeta = useSessionStore((s) => s.variables.find((v) => v.variable === s.variable));

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-700/60 bg-slate-900/80 p-3 text-xs text-slate-400">
        Loading profile...
      </div>
    );
  }
  if (!profile) return null;

  const close = () => {
    setSelectedProfile(null);
    setMatchup(null);
  };

  return (
    <div className="w-72 rounded-lg border border-slate-700/60 bg-slate-900/90 p-3 backdrop-blur">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400">
            {profile.platform} profile
          </div>
          <div className="font-mono text-sm text-slate-100">{profile.id}</div>
          <div className="text-[10px] text-slate-500">
            {profile.lat.toFixed(2)}&deg;N {profile.lon.toFixed(2)}&deg;E &middot;{" "}
            {profile.time.slice(0, 10)} &middot; mode {profile.dataMode}
          </div>
        </div>
        <button
          onClick={close}
          className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          aria-label="Close profile"
        >
          &times;
        </button>
      </div>

      {matchup ? (
        <>
          <div className="mb-2 rounded border border-slate-700/50 bg-slate-950/50 p-2">
            <div className="grid grid-cols-4 gap-1.5">
              <Stat label="Bias" value={matchup.bias} hint="mean(model - observation)" />
              <Stat label="RMSE" value={matchup.rmse} />
              <Stat label="MAE" value={matchup.mae} />
              <Stat label="Corr" value={matchup.corr} hint="Pearson correlation" />
            </div>
            <div className="mt-1 text-[9px] text-slate-500">
              bias / rmse / mae in {varMeta?.units ?? ""}
            </div>
          </div>
          <div className="mb-1 text-[10px] leading-relaxed text-slate-500">
            {matchup.n} levels matched within {matchup.radiusKm} km /{" "}
            {matchup.windowHours} h &middot; QC {matchup.qcFlagsUsed.join(",")} only
          </div>
          <ProfileChart />
          <div className="mt-1 border-t border-slate-800 pt-1.5 text-[9px] leading-relaxed text-slate-500">
            Model interpolated onto observation depths. Statistics use QC flag 1
            (good) only; display keeps 1 and 2.
          </div>
        </>
      ) : (
        <div className="text-xs text-slate-400">
          No matchup for this profile and variable.
        </div>
      )}
    </div>
  );
}
