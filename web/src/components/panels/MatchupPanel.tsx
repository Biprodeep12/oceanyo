"use client";

// The scientific differentiator, made visible.
//
// Shows the observed profile against the model interpolated onto the same
// depths, plus the standard validation statistics. Measured values only --
// nothing here is generated or inferred.

import { useMemo, useState } from "react";
import { useIsMobile } from "@/state/useMediaQuery";
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
      <span className="text-[9px] uppercase tracking-wider text-[color:var(--ze-text-faint)]">
        {label}
      </span>
      <span className="truncate font-mono text-[13px] text-[color:var(--ze-text)]">
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

    const W = 326;
    const H = 384;
    const L = 38;
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
            stroke="var(--ze-grid)" strokeWidth={1}
          />
          <text x={4} y={chart.y(d) + 3} fill="var(--ze-chart-text)" fontSize={9} fontFamily="monospace">
            {d}
          </text>
        </g>
      ))}
      <text x={4} y={chart.H - 4} fill="var(--ze-chart-text)" fontSize={9}>m</text>
      <path d={chart.model} fill="none" stroke="var(--ze-series-model)" strokeWidth={1.8} opacity={0.95} />
      <path d={chart.obs} fill="none" stroke="var(--ze-series-obs)" strokeWidth={1.8} opacity={0.95} />
      <g transform={`translate(${chart.L + 4}, ${chart.H - 12})`}>
        <line x1={0} x2={14} y1={-3} y2={-3} stroke="var(--ze-series-model)" strokeWidth={2} />
        <text x={18} y={0} fill="var(--ze-chart-label)" fontSize={9}>model</text>
        <line x1={58} x2={72} y1={-3} y2={-3} stroke="var(--ze-series-obs)" strokeWidth={2} />
        <text x={76} y={0} fill="var(--ze-chart-label)" fontSize={9}>
          {profile?.platform ?? "obs"}
        </text>
      </g>
    </svg>
  );
}

/**
 * Taylor diagram -- the figure operational ocean-model validation is reported
 * in, and the one an INCOIS evaluator will recognise on sight.
 *
 * Three statistics are shown as ONE point, because geometry ties them together:
 * radius is the model's standard deviation normalised by the observation's,
 * azimuth is arccos(correlation), and by the law of cosines the distance from
 * that point to the reference at (1, 0) IS the centred RMSE. So a point that
 * sits on the unit arc has the right variability, a point near the horizontal
 * axis has the right phase, and a point close to REF is simply right.
 *
 * Drawn from stdObs / stdModel / corr / crmse, which the matchup endpoint
 * already computes -- nothing here is re-derived in the browser.
 */
function TaylorDiagram() {
  const matchup = useSessionStore((s) => s.matchup);

  const g = useMemo(() => {
    if (!matchup) return null;
    const { stdObs, stdModel, corr } = matchup;
    if (!stdObs || stdModel == null || corr == null || stdObs <= 0) return null;

    const sd = stdModel / stdObs; // normalised standard deviation
    const W = 326;
    const H = 224;
    const L = 34; // origin x
    const B = H - 22; // origin y
    // Scale so the reference arc (sd = 1) sits at 60% of the usable width,
    // leaving room for a model that is more variable than the observation.
    const maxSd = Math.max(1.6, Math.min(2.5, sd * 1.25));
    const R = Math.min(W - L - 42, B - 14) / maxSd;
    const pt = (s: number, c: number) => {
      const th = Math.acos(Math.max(-1, Math.min(1, c)));
      return [L + s * R * Math.cos(th), B - s * R * Math.sin(th)] as const;
    };
    const arc = (s: number) => {
      const [x0, y0] = pt(s, 1);
      const [x1, y1] = pt(s, 0);
      return `M${x0.toFixed(1)},${y0.toFixed(1)} A${(s * R).toFixed(1)},${(s * R).toFixed(1)} 0 0 0 ${x1.toFixed(1)},${y1.toFixed(1)}`;
    };
    return { W, H, L, B, R, sd, corr, maxSd, pt, arc };
  }, [matchup]);

  if (!g) {
    return (
      <div className="mt-1 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
        Not enough matched levels to place a Taylor point.
      </div>
    );
  }

  const sdRings = [0.5, 1, 1.5].filter((s) => s <= g.maxSd);
  const corrTicks = [0, 0.5, 0.8, 0.95, 0.99];
  const [mx, my] = g.pt(g.sd, g.corr);
  const [rx, ry] = g.pt(1, 1);

  return (
    <svg width={g.W} height={g.H} className="mt-1" role="img" aria-label="Taylor diagram">
      {/* constant-correlation spokes */}
      {corrTicks.map((c) => {
        const [x, y] = g.pt(g.maxSd, c);
        const [lx, ly] = g.pt(g.maxSd * 1.06, c);
        return (
          <g key={c}>
            <line x1={g.L} y1={g.B} x2={x} y2={y} stroke="var(--ze-grid)" strokeWidth={1} />
            <text x={lx} y={ly} fill="var(--ze-chart-text)" fontSize={8} fontFamily="monospace"
              textAnchor="middle" dominantBaseline="middle">
              {c}
            </text>
          </g>
        );
      })}
      {/* normalised standard-deviation arcs; the sd=1 arc is the reference */}
      {sdRings.map((s) => (
        <path key={s} d={g.arc(s)} fill="none"
          stroke={s === 1 ? "var(--ze-grid-strong)" : "var(--ze-grid)"}
          strokeWidth={1}
          strokeDasharray={s === 1 ? "3 3" : undefined} />
      ))}
      {/* centred-RMSE arcs, centred on the reference point */}
      {[0.5, 1].map((e) => (
        <circle key={e} cx={rx} cy={ry} r={e * g.R} fill="none" stroke="var(--ze-chart-ring)"
          strokeWidth={1} strokeDasharray="2 4" />
      ))}
      {/* reference: a perfect model */}
      <circle cx={rx} cy={ry} r={3.5} fill="var(--ze-chart-label)" />
      <text x={rx} y={ry + 13} fill="var(--ze-chart-label)" fontSize={8} textAnchor="middle">REF</text>
      {/* the model */}
      <circle cx={mx} cy={my} r={4.5} fill="var(--ze-series-model)" stroke="var(--ze-panel-solid)" strokeWidth={1.2} />
      <text x={4} y={12} fill="var(--ze-chart-text)" fontSize={8} fontFamily="monospace">
        sd*={g.sd.toFixed(2)}
      </text>
      <text x={4} y={22} fill="var(--ze-chart-text)" fontSize={8} fontFamily="monospace">
        r={g.corr.toFixed(3)}
      </text>
      <text x={g.W - 4} y={g.H - 4} fill="var(--ze-chart-text)" fontSize={8} textAnchor="end">
        correlation
      </text>
      <text x={4} y={g.B + 12} fill="var(--ze-chart-text)" fontSize={8}>sd / sd_obs</text>
    </svg>
  );
}

/**
 * Temperature-salinity diagram -- multi-variable comparison, in the form the
 * field actually uses.
 *
 * The Level 2 list asks for "multi-variable comparison". Two profiles side by
 * side would satisfy the words and teach nothing: the reason temperature and
 * salinity are read TOGETHER is that a water mass is defined by the pair, and
 * only a T-S plot shows it. A Bay of Bengal float draws its own signature --
 * a near-vertical fresh limb near the surface from the Ganges-Brahmaputra
 * plume, bending into the salty Arabian Sea water below -- and two separate
 * depth profiles simply do not.
 *
 * Colour is depth, because a T-S plot loses the depth axis by construction and
 * without it the curve cannot be read in the right direction.
 *
 * Both series come from the SAME profile, so this needs no second request and
 * no model: it is the instrument compared with itself.
 */
function TSDiagram() {
  const profile = useSessionStore((s) => s.selectedProfile);

  const g = useMemo(() => {
    const t = profile?.variables?.temperature;
    const sa = profile?.variables?.salinity;
    if (!profile || !t || !sa) return null;

    const pts: { t: number; s: number; d: number }[] = [];
    const n = Math.min(profile.depth.length, t.values.length, sa.values.length);
    for (let i = 0; i < n; i++) {
      const tv = t.values[i];
      const sv = sa.values[i];
      // Display QC: flags 1 and 2. This is a picture of the water column, not
      // a statistic, and dropping "probably good" would punch holes in a curve
      // whose SHAPE is the whole point.
      if (tv == null || sv == null) continue;
      if (![1, 2].includes(t.qc[i]) || ![1, 2].includes(sa.qc[i])) continue;
      pts.push({ t: tv, s: sv, d: profile.depth[i] });
    }
    if (pts.length < 4) return null;

    const ts = pts.map((p) => p.t);
    const ss = pts.map((p) => p.s);
    const tMin = Math.min(...ts);
    const tMax = Math.max(...ts);
    const sMin = Math.min(...ss);
    const sMax = Math.max(...ss);
    const dMax = Math.max(...pts.map((p) => p.d)) || 1;

    const W = 326;
    const H = 300;
    const L = 40;
    const T = 10;
    const B = H - 26;
    const padT = (tMax - tMin) * 0.06 || 0.5;
    const padS = (sMax - sMin) * 0.06 || 0.05;
    const x = (v: number) => L + ((v - (sMin - padS)) / (sMax - sMin + 2 * padS)) * (W - L - 10);
    const y = (v: number) => B - ((v - (tMin - padT)) / (tMax - tMin + 2 * padT)) * (B - T);
    return { W, H, L, T, B, x, y, pts, tMin, tMax, sMin, sMax, dMax };
  }, [profile]);

  if (!g) {
    return (
      <div className="mt-1 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
        This profile does not carry both temperature and salinity, so there is
        no T-S curve to draw.
      </div>
    );
  }

  // Shallow to deep, warm to cold. Sequential rather than diverging: depth has
  // no meaningful midpoint to diverge about.
  const depthColor = (d: number) => {
    const f = Math.min(1, d / g.dMax);
    const stops = ["#f2c14e", "#3fb98a", "#2f7f9e", "#2b3a63"];
    const i = Math.min(stops.length - 2, Math.floor(f * (stops.length - 1)));
    return stops[f >= 1 ? stops.length - 1 : i];
  };

  const path = g.pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${g.x(p.s).toFixed(1)},${g.y(p.t).toFixed(1)}`)
    .join(" ");

  const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

  return (
    <svg width={g.W} height={g.H} className="mt-1" role="img" aria-label="Temperature-salinity diagram">
      {[0, 0.5, 1].map((f) => {
        const t = g.tMin + (g.tMax - g.tMin) * f;
        return (
          <g key={`t${f}`}>
            <line x1={g.L} x2={g.W - 10} y1={g.y(t)} y2={g.y(t)} stroke="var(--ze-grid)" strokeWidth={1} />
            <text x={4} y={g.y(t) + 3} fill="var(--ze-chart-text)" fontSize={9} fontFamily="monospace">
              {fmt(t)}
            </text>
          </g>
        );
      })}
      {[0, 0.5, 1].map((f) => {
        const sv = g.sMin + (g.sMax - g.sMin) * f;
        return (
          <g key={`s${f}`}>
            <line x1={g.x(sv)} x2={g.x(sv)} y1={g.T} y2={g.B} stroke="var(--ze-grid)" strokeWidth={1} />
            <text x={g.x(sv)} y={g.B + 12} fill="var(--ze-chart-text)" fontSize={9}
              fontFamily="monospace" textAnchor="middle">
              {fmt(sv)}
            </text>
          </g>
        );
      })}
      <path d={path} fill="none" stroke="var(--ze-grid-strong)" strokeWidth={1} opacity={0.7} />
      {g.pts.map((p, i) => (
        <circle key={i} cx={g.x(p.s)} cy={g.y(p.t)} r={2.1} fill={depthColor(p.d)} />
      ))}
      <text x={4} y={g.T + 2} fill="var(--ze-chart-text)" fontSize={9}>degC</text>
      <text x={g.W - 6} y={g.H - 4} fill="var(--ze-chart-text)" fontSize={9} textAnchor="end">
        salinity
      </text>
      {/* Depth legend: without it the colour is decoration. */}
      <g transform={`translate(${g.L}, ${g.H - 8})`}>
        {[0, 0.33, 0.66, 1].map((f, i) => (
          <rect key={i} x={i * 14} y={-7} width={13} height={5} fill={depthColor(f * g.dMax)} />
        ))}
        <text x={62} y={-2.5} fill="var(--ze-chart-label)" fontSize={8}>
          0 to {Math.round(g.dMax)} m
        </text>
      </g>
    </svg>
  );
}

export default function MatchupPanel() {
  const [chartTab, setChartTab] = useState<"profile" | "taylor" | "ts">("profile");
  const matchup = useSessionStore((s) => s.matchup);
  const profile = useSessionStore((s) => s.selectedProfile);
  const loading = useSessionStore((s) => s.loadingProfile);
  const setSelectedProfile = useSessionStore((s) => s.setSelectedProfile);
  const setMatchup = useSessionStore((s) => s.setMatchup);
  const varMeta = useSessionStore((s) => s.variables.find((v) => v.variable === s.variable));
  const mobile = useIsMobile();

  if (loading) {
    return (
      <div className="ze-panel px-3.5 py-3 text-[12px] text-[color:var(--ze-text-dim)]">
        Loading profile&hellip;
      </div>
    );
  }
  if (!profile) return null;

  const close = () => {
    setSelectedProfile(null);
    setMatchup(null);
  };

  return (
    <div
      className={
        mobile
          ? // Anchored to the TOP on a phone: the bottom belongs to the
            // timeline and the colour scale, and a profile that covered them
            // would hide the controls needed to change what it is showing.
            "ze-panel fixed inset-x-2 top-2 max-h-[58dvh] overflow-y-auto p-3.5"
          : // Wider than the rail-adjacent panels: this one carries a four-column
            // statistics row, a depth profile and a Taylor diagram, and at
            // 288px the chart was 240px of plot for a 2000 m axis. Capped to
            // the viewport so a deep profile scrolls inside the panel instead
            // of running off the bottom of the screen.
            "ze-panel ze-scroll max-h-[calc(100dvh-24px)] w-[360px] overflow-y-auto p-3.5"
      }
    >
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="ze-section-label !m-0 !p-0">{profile.platform} profile</div>
          <div className="mt-0.5 font-mono text-[13px] text-[color:var(--ze-text)]">
            {profile.id}
          </div>
          <div className="text-[10px] text-[color:var(--ze-text-faint)]">
            {profile.lat.toFixed(2)}&deg;N {profile.lon.toFixed(2)}&deg;E &middot;{" "}
            {profile.time.slice(0, 10)} &middot; mode {profile.dataMode}
          </div>
        </div>
        <button
          onClick={close}
          className="grid h-6 w-6 place-items-center rounded-md text-[color:var(--ze-text-dim)] hover:bg-white/10 hover:text-white"
          aria-label="Close profile"
        >
          &times;
        </button>
      </div>

      {matchup ? (
        <>
          <div className="mb-2 rounded-lg bg-black/25 p-2.5">
            <div className="grid grid-cols-4 gap-1.5">
              <Stat label="Bias" value={matchup.bias} hint="mean(model - observation)" />
              <Stat label="RMSE" value={matchup.rmse} />
              <Stat label="MAE" value={matchup.mae} />
              <Stat label="Corr" value={matchup.corr} hint="Pearson correlation" />
            </div>
            <div className="mt-1.5 text-[9px] text-[color:var(--ze-text-faint)]">
              bias / rmse / mae in {varMeta?.units ?? ""}
            </div>
          </div>
          <div className="mb-1 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
            {/* Both are now derived from the model's own grid and timestep, so
                they arrive as awkward reals rather than the round numbers a
                fixed default gave. */}
            {/* Dashes with no explanation read as a broken panel. There are two
                quite different reasons for them and the user cannot tell which:
                a profile that carried nothing usable (real Argo floats often
                return a near-empty deployment cycle -- one of ours has a single
                finite level, flagged bad), or a profile with good data and no
                model within the colocation window. */}
            {matchup.n === 0 && (
              <div className="mb-1 text-[color:var(--ze-warn)]">
                {matchup.obsDepths.length === 0
                  ? "No levels in this profile passed QC, so there is nothing to compare."
                  : "No model data within the colocation window for this profile."}
              </div>
            )}
            {matchup.n} levels matched within {Math.round(matchup.radiusKm)} km /{" "}
            {matchup.windowHours >= 48
              ? `${Math.round(matchup.windowHours / 24)} d`
              : `${Math.round(matchup.windowHours)} h`}{" "}
            &middot; QC {matchup.qcFlagsUsed.join(",")} only
          </div>
          <div className="mt-1.5 flex gap-1" role="tablist" aria-label="Chart">
            {(["profile", "taylor", "ts"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={chartTab === t}
                onClick={() => setChartTab(t)}
                className="ze-btn !px-2.5 !py-1 !text-[10px]"
                data-active={chartTab === t ? "true" : "false"}
                title={
                  t === "profile"
                    ? "Observed profile against the model at the same depths"
                    : t === "taylor"
                      ? "Standard deviation, correlation and centred RMSE as one point"
                      : "Temperature against salinity, coloured by depth: the water mass"
                }
              >
                {t === "profile" ? "Profile" : t === "taylor" ? "Taylor" : "T-S"}
              </button>
            ))}
          </div>
          {chartTab === "profile" ? (
            <ProfileChart />
          ) : chartTab === "taylor" ? (
            <TaylorDiagram />
          ) : (
            <TSDiagram />
          )}
          <div className="mt-1 border-t border-white/10 pt-1.5 text-[9px] leading-relaxed text-[color:var(--ze-text-faint)]">
            Model interpolated onto observation depths. Statistics use QC flag 1
            (good) only; display keeps 1 and 2.
          </div>
        </>
      ) : (
        <div className="text-[12px] text-[color:var(--ze-text-dim)]">
          No matchup for this profile and variable.
        </div>
      )}
    </div>
  );
}
