"use client";

// The query layer's tool schema, and a resolver that needs no model.
//
// Spec section 5.2 settles the architecture: define the tool schema first, and
// let the language model emit only structured calls against it, so the
// provider stays swappable and the platform logic never depends on one. It
// also states a hard requirement -- "**Deterministic fallback required.** Ship
// a keyword matcher covering the six phrases you will actually demo. If
// conference wifi fails or the free tier rate-limits mid-pitch, the feature
// still works."
//
// This file is that fallback, and it is the DEFAULT rather than the backstop.
// A free-tier model is a third-party dependency, a rate limit, and a prompt log
// containing a ministry's queries, in exchange for parsing "bay of bengal" --
// which a lookup table does correctly, offline, in microseconds. When a model
// is wired in later it emits exactly these Tool objects and everything
// downstream is unchanged; `resolve` becomes the fallback path it was
// specified as.
//
// Two of the design rules in 5.2 are enforced here rather than in the UI:
// resolution is reported (every result carries the `label` shown to the user
// before anything happens), and nothing is ever generated -- `query_floats`
// returns a call for the SERVER to answer against the observation index.

import type { RegionPreset, VariableSummary } from "@/lib/api/types";

export type Tool =
  | { name: "select_region"; args: { bbox: [number, number, number, number]; depthRange: [number, number] } }
  | { name: "select_preset"; args: { region: string } }
  | { name: "set_variable"; args: { variable: string } }
  | { name: "set_depth"; args: { depth: number } }
  | { name: "set_time"; args: { time: string } }
  | { name: "query_floats"; args: { sortBy: SortKey; order: "desc" | "asc"; limit: number } }
  | { name: "focus_platform"; args: { platform: string; id: string } }
  // --- two extensions to the schema in 5.2 ---
  // The spec's list predates the Level 2 assessment layers and the extrude
  // being a discrete action. Both are additions to the same closed schema, not
  // free-form commands, so the guarantee that the layer can only ever do what
  // the UI can do still holds.
  | { name: "set_layer"; args: { layer: Metric | "anomaly" | "none" } }
  | { name: "dive"; args: Record<string, never> };

export type SortKey = "trajectory_length" | "model_error" | "recency" | "profile_count";
type Metric = "count" | "blindSpot" | "bias" | "rmse" | "confidence" | "ageDays";

export interface Resolution {
  tool: Tool;
  /** What the user is told BEFORE it runs. Section 5.2: never act silently. */
  label: string;
  /** Ranking hint; higher wins when several rules fire. */
  score: number;
  /** Category, for grouping in the palette. */
  group: "Region" | "Variable" | "Depth" | "Time" | "Layer" | "Instruments" | "Action";
}

export interface ResolveContext {
  presets: RegionPreset[];
  variables: VariableSummary[];
  times: string[];
  instrumentIds: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ").trim();

/** Every token of `needle` appears in `hay`, in any order. */
function loose(hay: string, needle: string): boolean {
  const parts = norm(needle).split(" ").filter(Boolean);
  if (!parts.length) return false;
  const h = norm(hay);
  return parts.every((p) => h.includes(p));
}

const VARIABLE_WORDS: Record<string, string[]> = {
  temperature: ["temperature", "temp", "thermal", "warm", "cold", "sst", "thetao"],
  salinity: ["salinity", "salt", "salty", "psu", "haline"],
  chlorophyll: ["chlorophyll", "chl", "bloom", "productivity", "algae", "bgc"],
  u: ["eastward", "zonal", "u velocity"],
  v: ["northward", "meridional", "v velocity"],
};

const LAYER_WORDS: { layer: Metric | "anomaly" | "none"; label: string; words: string[] }[] = [
  { layer: "count", label: "Observation coverage", words: ["coverage", "how many floats", "observation density", "observed"] },
  { layer: "blindSpot", label: "Blind spots", words: ["blind spot", "blindspot", "gap", "unobserved", "nothing measured"] },
  { layer: "rmse", label: "Model accuracy", words: ["accuracy", "rmse", "error map", "how wrong", "model error"] },
  { layer: "bias", label: "Model bias", words: ["bias", "warm bias", "cold bias", "too warm", "too cold"] },
  { layer: "confidence", label: "Confidence", words: ["confidence", "trust", "reliable", "how much to believe"] },
  { layer: "ageDays", label: "Data freshness", words: ["freshness", "how old", "stale", "recent data", "age"] },
  { layer: "anomaly", label: "Climatology anomaly", words: ["anomaly", "vs climatology", "departure", "heatwave"] },
  { layer: "none", label: "Clear the assessment layer", words: ["clear layer", "no layer", "hide assessment", "plain map"] },
];

const SORT_WORDS: { key: SortKey; label: string; words: string[] }[] = [
  { key: "trajectory_length", label: "the longest-travelling instruments", words: ["longest", "furthest", "farthest", "travelled", "traveled", "drifted", "distance"] },
  { key: "model_error", label: "the instruments that disagree most with the model", words: ["disagree", "worst", "largest error", "biggest error", "least accurate", "outlier"] },
  { key: "recency", label: "the most recently reporting instruments", words: ["recent", "newest", "latest", "last reported", "freshest"] },
  { key: "profile_count", label: "the instruments with the most profiles", words: ["most profiles", "most cycles", "busiest", "most data"] },
];

/**
 * Turn a phrase into candidate tool calls, ranked.
 *
 * Returns several, not one: "bay of bengal salinity" is two calls, and a query
 * that could mean two things should offer both rather than pick. The palette
 * runs whichever the user confirms.
 */
export function resolve(query: string, ctx: ResolveContext): Resolution[] {
  const q = norm(query);
  const out: Resolution[] = [];
  if (!q) return out;

  // --- regions ---
  for (const p of ctx.presets) {
    if (loose(`${p.label} ${p.id}`, q) || loose(q, p.label)) {
      out.push({
        tool: { name: "select_preset", args: { region: p.id } },
        label: `Select ${p.label}`,
        score: 90,
        group: "Region",
      });
    }
  }

  // --- variables ---
  for (const v of ctx.variables) {
    const words = VARIABLE_WORDS[v.variable] ?? [v.variable];
    if (words.some((w) => q.includes(w)) || loose(v.longName, q)) {
      out.push({
        tool: { name: "set_variable", args: { variable: v.variable } },
        label: `Show ${v.longName.toLowerCase()}`,
        score: 80,
        group: "Variable",
      });
    }
  }

  // --- depth: "at 200 m", "200m", "depth 1000" ---
  const depth = /(?:^|\s)(?:at\s+|depth\s+)?(\d{1,4})\s*(?:m|metre|meter|metres|meters)\b/.exec(q)
    ?? /\bdepth\s+(\d{1,4})\b/.exec(q);
  if (depth) {
    const d = Number(depth[1]);
    out.push({
      tool: { name: "set_depth", args: { depth: d } },
      label: `Go to ${d} m`,
      score: 85,
      group: "Depth",
    });
  }

  // --- time: a year, a month, or a full date that exists in the record ---
  const dateLike = /\b(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?\b/.exec(q);
  if (dateLike && ctx.times.length) {
    const prefix = [
      dateLike[1],
      dateLike[2]?.padStart(2, "0"),
      dateLike[3]?.padStart(2, "0"),
    ].filter(Boolean).join("-");
    const hit = ctx.times.find((t) => t.startsWith(prefix));
    if (hit) {
      out.push({
        tool: { name: "set_time", args: { time: hit } },
        label: `Jump to ${hit.slice(0, 10)}`,
        score: 84,
        group: "Time",
      });
    }
  }

  // --- assessment layers ---
  for (const l of LAYER_WORDS) {
    if (l.words.some((w) => q.includes(w))) {
      out.push({
        tool: { name: "set_layer", args: { layer: l.layer } },
        label: l.label,
        score: 82,
        group: "Layer",
      });
    }
  }

  // --- questions about the network, answered by the server ---
  for (const s of SORT_WORDS) {
    if (s.words.some((w) => q.includes(w))) {
      const asc = /\b(least|smallest|shortest|fewest|oldest)\b/.test(q);
      out.push({
        tool: {
          name: "query_floats",
          args: { sortBy: s.key, order: asc ? "asc" : "desc", limit: 10 },
        },
        label: `List ${s.label}`,
        score: 88,
        group: "Instruments",
      });
    }
  }

  // --- a specific instrument, by id ---
  const idish = q.replace(/\s+/g, "");
  if (idish.length >= 3) {
    for (const id of ctx.instrumentIds) {
      if (id.toLowerCase().includes(idish)) {
        out.push({
          tool: { name: "focus_platform", args: { platform: "", id } },
          label: `Focus ${id}`,
          score: 95,
          group: "Instruments",
        });
        if (out.filter((r) => r.group === "Instruments").length > 8) break;
      }
    }
  }

  // --- the one action ---
  if (/\b(dive|extrude|3d|block|go down)\b/.test(q)) {
    out.push({
      tool: { name: "dive", args: {} },
      label: "Extrude the selected region into a 3D block",
      score: 70,
      group: "Action",
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

/** A one-line rendering of a tool call, for the "resolved parameters" line. */
export function describe(tool: Tool): string {
  switch (tool.name) {
    case "select_preset":
      return `select_preset(region: ${tool.args.region})`;
    case "select_region":
      return `select_region(bbox: ${tool.args.bbox.join(", ")})`;
    case "set_variable":
      return `set_variable(variable: ${tool.args.variable})`;
    case "set_depth":
      return `set_depth(depth: ${tool.args.depth} m)`;
    case "set_time":
      return `set_time(time: ${tool.args.time})`;
    case "set_layer":
      return `set_layer(layer: ${tool.args.layer})`;
    case "query_floats":
      return `query_floats(sortBy: ${tool.args.sortBy}, order: ${tool.args.order}, limit: ${tool.args.limit})`;
    case "focus_platform":
      return `focus_platform(id: ${tool.args.id})`;
    case "dive":
      return "dive()";
  }
}
