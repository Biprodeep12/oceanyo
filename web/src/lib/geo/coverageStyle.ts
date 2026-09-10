// Paint expressions and legends for the assessment grid.
//
// One endpoint returns one grid carrying every Level 2 assessment property;
// which of them is on screen is purely a styling decision, so it lives here
// rather than in the map component. Each metric declares its own colour ramp
// AND the legend that explains it, in one place -- a legend that is written
// separately from the ramp drifts from it the first time a threshold moves.

import type { CoverageMetric, CoverageResponse } from "@/lib/api/types";

export interface MetricSpec {
  key: CoverageMetric;
  label: string;
  /** What the layer answers, in the words someone would ask it. */
  question: string;
  /** Legend swatches, low to high. */
  legend: { color: string; label: string }[];
  /** Ramp midpoint/extent note shown under the legend, or "". */
  note: string;
}

/** Cells the metric has nothing to say about are drawn as a faint hatch-free
 *  grey rather than hidden: "no data here" is itself the finding. */
const NODATA = "rgba(130,148,166,0.10)";

const SEQ = ["#2b3a4a", "#2f7f9e", "#3fb98a", "#e8c15a", "#e2603f"];
const DIVERGING = ["#3a6ea8", "#7fa8cf", "#e8eef4", "#e0a06a", "#c2452f"];

type Expr = unknown[];

function ramp(field: string, stops: [number, string][]): Expr {
  const out: unknown[] = ["interpolate", ["linear"], ["get", field]];
  for (const [v, c] of stops) out.push(v, c);
  return out;
}

/** Guard a ramp against nulls: MapLibre coerces a missing number to 0, which
 *  would paint an unobserved cell as if it had a bias of exactly zero. */
function whenPresent(field: string, expr: Expr): Expr {
  return ["case", ["==", ["typeof", ["get", field]], "number"], expr, NODATA];
}

function niceMax(values: number[], floor: number): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return floor;
  // 90th percentile, not the maximum: one outlier cell should not compress
  // every other cell into the first swatch.
  const sorted = [...finite].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  return Math.max(floor, p90 || floor);
}

const fmt = (v: number, unit = "") =>
  `${v >= 100 ? Math.round(v) : Number(v.toFixed(v >= 10 ? 1 : 2))}${unit}`;

/**
 * Build the fill-colour expression and matching legend for one metric.
 *
 * Ranges are derived from the data in view rather than fixed, because an RMSE
 * of 1 degC is unremarkable for temperature and enormous for salinity; a
 * hardcoded ramp would be right for exactly one variable.
 */
export function coverageStyle(
  metric: CoverageMetric,
  data: CoverageResponse | null,
): { paint: Expr; spec: MetricSpec } {
  const props = (data?.features ?? []).map((f) => f.properties);
  const units = data?.summary.units ?? "";

  switch (metric) {
    case "count": {
      const hi = niceMax(props.map((p) => p.count), 4);
      return {
        paint: [
          "case",
          ["==", ["get", "count"], 0], NODATA,
          ramp("count", [
            [1, SEQ[1]],
            [Math.max(2, hi / 3), SEQ[2]],
            [Math.max(3, (hi * 2) / 3), SEQ[3]],
            [Math.max(4, hi), SEQ[4]],
          ]),
        ],
        spec: {
          key: metric,
          label: "Observation coverage",
          question: "How many profiles has this cell contributed?",
          legend: [
            { color: NODATA, label: "none" },
            { color: SEQ[1], label: "1" },
            { color: SEQ[2], label: fmt(hi / 3) },
            { color: SEQ[3], label: fmt((hi * 2) / 3) },
            { color: SEQ[4], label: `${fmt(hi)}+` },
          ],
          note: "profiles per cell",
        },
      };
    }

    case "blindSpot":
      return {
        // The one metric with a fixed ramp, because it is a fact rather than a
        // measurement: ocean with nothing in it.
        paint: [
          "case",
          ["==", ["get", "blindSpot"], true], "rgba(226,96,63,0.55)",
          ["==", ["get", "ocean"], false], "rgba(130,148,166,0.06)",
          "rgba(63,185,138,0.28)",
        ],
        spec: {
          key: metric,
          label: "Blind spots",
          question: "Where is there ocean and no observation at all?",
          legend: [
            { color: "rgba(226,96,63,0.55)", label: "unobserved" },
            { color: "rgba(63,185,138,0.28)", label: "observed" },
            { color: "rgba(130,148,166,0.06)", label: "not ocean" },
          ],
          note: "land and shelf are masked with the bathymetry, so a gap here is a gap in the observing network",
        },
      };

    case "bias": {
      const hi = niceMax(props.map((p) => Math.abs(p.bias ?? NaN)), 0.1);
      return {
        paint: whenPresent(
          "bias",
          ramp("bias", [
            [-hi, DIVERGING[0]],
            [-hi / 2, DIVERGING[1]],
            [0, DIVERGING[2]],
            [hi / 2, DIVERGING[3]],
            [hi, DIVERGING[4]],
          ]),
        ),
        spec: {
          key: metric,
          label: "Model bias",
          question: "Does the model run warm or cold against the floats here?",
          legend: [
            { color: DIVERGING[0], label: `-${fmt(hi)}` },
            { color: DIVERGING[1], label: "" },
            { color: DIVERGING[2], label: "0" },
            { color: DIVERGING[3], label: "" },
            { color: DIVERGING[4], label: `+${fmt(hi)}` },
          ],
          note: `model minus observation, ${units}; diverging so the sign reads`,
        },
      };
    }

    case "rmse": {
      const hi = niceMax(props.map((p) => p.rmse ?? NaN), 0.5);
      return {
        paint: whenPresent(
          "rmse",
          ramp("rmse", [
            [0, SEQ[2]],
            [hi / 2, SEQ[3]],
            [hi, SEQ[4]],
          ]),
        ),
        spec: {
          key: metric,
          label: "Model accuracy",
          question: "How far is the model from the floats, ignoring sign?",
          legend: [
            { color: SEQ[2], label: "0" },
            { color: SEQ[3], label: fmt(hi / 2) },
            { color: SEQ[4], label: `${fmt(hi)}+` },
            { color: NODATA, label: "no matchup" },
          ],
          note: `RMSE, ${units}; pooled across profiles by level count`,
        },
      };
    }

    case "confidence":
      return {
        paint: whenPresent(
          "confidence",
          ramp("confidence", [
            [0, SEQ[4]],
            [0.35, SEQ[3]],
            [0.7, SEQ[2]],
            [1, "#2fd6a0"],
          ]),
        ),
        spec: {
          key: metric,
          label: "Confidence",
          question: "How much should this region's model field be trusted?",
          legend: [
            { color: SEQ[4], label: "low" },
            { color: SEQ[3], label: "" },
            { color: SEQ[2], label: "" },
            { color: "#2fd6a0", label: "high" },
            { color: NODATA, label: "unknown" },
          ],
          note: "how much evidence there is, times how well it agrees; both measured",
        },
      };

    case "ageDays": {
      const hi = niceMax(props.map((p) => p.ageDays ?? NaN), 30);
      return {
        paint: whenPresent(
          "ageDays",
          ramp("ageDays", [
            [0, "#2fd6a0"],
            [hi / 3, SEQ[3]],
            [hi, SEQ[4]],
          ]),
        ),
        spec: {
          key: metric,
          label: "Data freshness",
          question: "How long since anything was measured here?",
          legend: [
            { color: "#2fd6a0", label: "newest" },
            { color: SEQ[3], label: `${fmt(hi / 3)} d` },
            { color: SEQ[4], label: `${fmt(hi)}+ d` },
            { color: NODATA, label: "never" },
          ],
          note: "age against the newest data in the catalogue, not against today",
        },
      };
    }
  }
}

export const COVERAGE_METRICS: CoverageMetric[] = [
  "count",
  "blindSpot",
  "rmse",
  "bias",
  "confidence",
  "ageDays",
];
