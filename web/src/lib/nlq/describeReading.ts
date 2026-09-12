// Turning a tool result into something a person reads.
//
// The assistant's evidence used to be printed as the JSON the tool returned.
// That is the most faithful thing to show and the least useful: the one number
// the answer rests on sits in the middle of eighteen lines of arrays, and a
// reader who has to hunt for it stops checking after the first question --
// which defeats the point of printing the evidence at all.
//
// So each tool gets a summary: a line saying what was measured, and the
// figures that matter, labelled. The raw JSON is still one click away and is
// still the authority; this is an index into it, not a replacement for it.
//
// One rule holds throughout: NO FIGURE HERE IS RECOMPUTED. The server checks
// every number in the assistant's prose against the numbers in these results,
// so a value shown at a different magnitude would read as a contradiction
// between an answer and its own evidence. The one liberty taken is length --
// a float that arrives as 0.6277792280200073 is shown to six significant
// figures, because seventeen digits in a 400px column are unreadable and the
// exact value is one click away in the raw result. Anything derived -- a
// percentage, a count of rows -- comes from the result and says what it is.

import { shortLabel } from "@/lib/variableLabels";

export interface Fact {
  label: string;
  value: string;
}

export interface ReadingSummary {
  /** One line: what this tool went and looked at. */
  headline: string;
  /** The figures, in the order they matter. */
  facts: Fact[];
  /** A caveat the tool carried, or the reason it could not answer. */
  note?: string;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** A measured value: the tool's own number, shortened but never rescaled. */
const fig = (v: unknown, unit = ""): string => {
  const n = num(v);
  if (n === null) return "—";
  const short = Number(n.toPrecision(6));
  return unit ? `${short} ${unit}` : String(short);
};

const day = (v: unknown): string => str(v)?.slice(0, 10) ?? "—";

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const nums = (v: unknown): number[] =>
  arr(v).filter((x): x is number => typeof x === "number" && Number.isFinite(x));

// Math.min(...xs) throws RangeError once the array is long enough to overflow
// the argument stack, somewhere around 100k. A per-timestep array is nowhere
// near that today and a daily century-long catalogue would not be, but a
// reduce costs the same and cannot be the thing that breaks.
const least = (xs: number[]): number => xs.reduce((a, b) => (b < a ? b : a), xs[0]);
const most = (xs: number[]): number => xs.reduce((a, b) => (b > a ? b : a), xs[0]);

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const deg = (v: number, pos: string, neg: string) =>
  `${Math.abs(v).toFixed(1)}°${v < 0 ? neg : pos}`;

const bboxText = (v: unknown): string | null => {
  const b = nums(v);
  if (b.length !== 4) return null;
  const [w, s, e, n] = b;
  return `${deg(w, "E", "W")}–${deg(e, "E", "W")}, ${deg(s, "N", "S")}–${deg(n, "N", "S")}`;
};

/** "warmestMean" -> "Warmest mean", for results with no bespoke formatter. */
const humanize = (key: string): string => {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

const varLabel = (r: Rec, args: Rec): string => {
  const v = str(r.variable) ?? str(args.variable);
  return v ? shortLabel(v).toLowerCase() : "the field";
};

const atDepth = (v: unknown): string => {
  const d = num(v);
  if (d === null) return "";
  return d === 0 ? " at the surface" : ` at ${d} m`;
};

const SORTED_BY: Record<string, string> = {
  trajectory_length: "distance travelled",
  model_error: "disagreement with the model",
  recency: "how recently they reported",
  profile_count: "how many profiles they carry",
};

// --- one formatter per read tool -----------------------------------------

function timeseries(r: Rec, args: Rec): ReadingSummary {
  const units = str(r.units) ?? "";
  const steps = arr(r.times).length;
  const lo = nums(r.min);
  const hi = nums(r.max);
  const facts: Fact[] = [];

  // "Highest" and "lowest" rather than the result's own "warmest": the same
  // tool answers for salinity and for chlorophyll, where warmth is not what
  // is being ranked.
  if (r.warmestStep) {
    facts.push({
      label: "Highest mean",
      value: `${fig(r.warmestMean, units)} on ${day(r.warmestStep)}`,
    });
  }
  if (r.coolestStep) {
    facts.push({
      label: "Lowest mean",
      value: `${fig(r.coolestMean, units)} on ${day(r.coolestStep)}`,
    });
  }
  // Both ends are values the result already lists, picked out of its own
  // arrays rather than computed from them.
  if (lo.length && hi.length) {
    facts.push({
      label: "Any single cell",
      value: `${least(lo)} to ${most(hi)} ${units}`.trim(),
    });
  }
  const box = bboxText(r.bbox);
  if (box) facts.push({ label: "Over", value: box });

  return {
    headline: `Spatial mean of ${varLabel(r, args)}${atDepth(r.depth)}, at each of ${plural(steps, "timestep")}`,
    facts,
  };
}

function pointValue(r: Rec, args: Rec): ReadingSummary {
  const units = str(r.units) ?? "";
  const lat = num(r.lat);
  const lon = num(r.lon);
  const where =
    lat !== null && lon !== null
      ? `${deg(lat, "N", "S")}, ${deg(lon, "E", "W")}`
      : "one point";
  return {
    headline: `${varLabel(r, args)} at ${where}`,
    facts: [
      { label: "Value", value: fig(r.value, units) },
      { label: "Depth", value: fig(r.depth, "m") },
      { label: "Nearest step", value: day(r.time) },
    ],
    note: str(r.note) ?? undefined,
  };
}

function assessment(r: Rec, args: Rec): ReadingSummary {
  const units = str(r.units) ?? "";
  const observed = num(r.observedCells);
  const ocean = num(r.oceanCells);
  const cover = num(r.coverage);
  const facts: Fact[] = [];

  if (observed !== null && ocean !== null) {
    facts.push({
      label: "Observed",
      value:
        `${observed} of ${ocean} ocean cells` +
        (cover !== null ? ` (${Math.round(cover * 100)}%)` : ""),
    });
  }
  if (num(r.blindSpots) !== null) {
    facts.push({ label: "Blind spots", value: `${fig(r.blindSpots)} cells` });
  }
  if (num(r.scored) !== null && num(r.profiles) !== null) {
    facts.push({
      label: "Matched",
      value: `${fig(r.scored)} of ${fig(r.profiles)} profiles`,
    });
  }
  if (num(r.regionalRmse) !== null) {
    facts.push({ label: "Regional RMSE", value: fig(r.regionalRmse, units) });
  }
  if (num(r.cellDeg) !== null) {
    facts.push({ label: "Cell size", value: `${fig(r.cellDeg)}°` });
  }
  // What it was compared against goes in the note rather than in a row: a
  // provenance string is a sentence long, and truncating it to fit a right
  // aligned column would be worse than not naming the model at all.
  const caveats = [
    str(r.modelSource) ? `against ${r.modelSource}` : null,
    r.maskedByBathymetry === false
      ? "no bathymetry mask in this catalogue: land counts as unobserved ocean"
      : null,
  ].filter(Boolean);

  return {
    headline: `How well observed ${varLabel(r, args)} is here, and how far the model sits from the floats`,
    facts,
    note: caveats.length ? caveats.join(" · ") : undefined,
  };
}

function events(r: Rec, args: Rec): ReadingSummary {
  const units = str(r.units) ?? "";
  const list = arr(r.events).filter(isRec);
  const facts: Fact[] = list.slice(0, 4).map((e) => ({
    label: `${str(e.kind) ?? "event"} · ${plural(num(e.steps) ?? 0, "step")}`,
    value: `${day(e.start)} to ${day(e.end)}, peak ${fig(e.peakAnomaly, units)} on ${day(e.peakTime)}`,
  }));
  if (list.length > facts.length) {
    facts.push({ label: "", value: `and ${list.length - facts.length} more` });
  }
  return {
    headline: list.length
      ? `${plural(list.length, "run")} of ${varLabel(r, args)} beyond the climatological threshold`
      : `No run of ${varLabel(r, args)} passed the climatological threshold`,
    facts,
    note: str(r.method) ?? undefined,
  };
}

function profile(r: Rec, args: Rec): ReadingSummary {
  const units = str(r.units) ?? "";
  const facts: Fact[] = [
    { label: "Bias", value: fig(r.bias, units) },
    { label: "RMSE", value: fig(r.rmse, units) },
  ];
  if (num(r.mae) !== null) facts.push({ label: "MAE", value: fig(r.mae, units) });
  if (num(r.corr) !== null) facts.push({ label: "Correlation", value: fig(r.corr) });
  if (num(r.levelsMatched) !== null) {
    facts.push({ label: "Levels matched", value: fig(r.levelsMatched) });
  }
  if (str(r.time)) facts.push({ label: "Cycle", value: day(r.time) });
  const lat = num(r.lat);
  const lon = num(r.lon);
  if (lat !== null && lon !== null) {
    facts.push({
      label: "Where",
      value: `${deg(lat, "N", "S")}, ${deg(lon, "E", "W")}`,
    });
  }
  const who = str(r.instrument) ?? str(args.instrument) ?? "one instrument";
  const plat = str(r.platform);
  return {
    headline: `${who}${plat ? ` (${plat})` : ""} against the model, in ${varLabel(r, args)}`,
    facts,
    note: str(r.note) ?? undefined,
  };
}

function instruments(r: Rec): ReadingSummary {
  const rows = arr(r.results).filter(isRec);
  const sortBy = str(r.sortBy) ?? "profile_count";
  const facts: Fact[] = rows.slice(0, 5).map((row, i) => {
    const id = str(row.instrument) ?? "—";
    const plat = str(row.platform);
    let detail: string;
    switch (sortBy) {
      case "trajectory_length":
        detail = `${fig(row.trajectoryKm, "km")} · ${fig(row.profiles)} profiles`;
        break;
      case "model_error":
        detail = `RMSE ${fig(row.rmse)} · ${fig(row.matched)} matched`;
        break;
      case "recency":
        detail = `last ${day(row.last)} · ${fig(row.profiles)} profiles`;
        break;
      default:
        detail = `${fig(row.profiles)} profiles · to ${day(row.last)}`;
    }
    return { label: `${i + 1}. ${id}${plat ? ` (${plat})` : ""}`, value: detail };
  });
  if (rows.length > facts.length) {
    facts.push({ label: "", value: `and ${rows.length - facts.length} more` });
  }
  const total = num(r.instruments) ?? rows.length;
  return {
    headline: `${total} instruments in the index, ranked by ${SORTED_BY[sortBy] ?? sortBy}`,
    facts,
  };
}

function catalog(r: Rec): ReadingSummary {
  const facts: Fact[] = [];
  if (str(r.source)) facts.push({ label: "Source", value: String(r.source) });
  facts.push({ label: "Kind", value: r.synthetic ? "synthetic twin" : "real data" });

  const vars = arr(r.variables).filter((v): v is string => typeof v === "string");
  if (vars.length) {
    facts.push({
      label: "Fields",
      value: vars.map((v) => shortLabel(v).toLowerCase()).join(", "),
    });
  }
  const range = arr(r.timeRange);
  if (range.length === 2) {
    facts.push({
      label: "Record",
      value: `${day(range[0])} to ${day(range[1])} · ${fig(r.timesteps)} steps`,
    });
  }
  const depth = nums(r.depthRange);
  if (depth.length === 2) {
    facts.push({ label: "Depth", value: `${depth[0]} to ${depth[1]} m` });
  }
  const box = bboxText(r.bbox);
  if (box) facts.push({ label: "Extent", value: box });
  if (isRec(r.profiles)) {
    const counts = Object.entries(r.profiles)
      .map(([k, v]) => `${k} ${fig(v)}`)
      .join(" · ");
    if (counts) facts.push({ label: "Profiles", value: counts });
  }
  return { headline: "What this catalogue is", facts };
}

/** Anything with no bespoke formatter: its scalars, labelled. */
function generic(tool: string, r: unknown): ReadingSummary {
  if (!isRec(r)) {
    // Clamped: no tool returns a bare array today, but one that returned a
    // long one would otherwise put the whole thing in the DOM as a note.
    return {
      headline: `${tool} returned ${typeof r}`,
      facts: [],
      note: String(r).slice(0, 200),
    };
  }
  const facts: Fact[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (k === "note" || k === "error") continue;
    if (typeof v === "number" || typeof v === "boolean") {
      facts.push({ label: humanize(k), value: String(v) });
    } else if (typeof v === "string") {
      facts.push({ label: humanize(k), value: v.length > 60 ? `${v.slice(0, 60)}…` : v });
    } else if (Array.isArray(v)) {
      facts.push({ label: humanize(k), value: plural(v.length, "value") });
    }
    if (facts.length >= 10) break;
  }
  return { headline: `What ${tool} returned`, facts, note: str(r.note) ?? undefined };
}

/**
 * Summarise one tool reading.
 *
 * `args` is consulted only for context the result omits -- which variable was
 * asked for, which instrument -- and never for a figure. A number shown here
 * has to be one that was measured.
 */
export function describeReading(
  tool: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
): ReadingSummary {
  const a = args ?? {};
  if (isRec(result) && str(result.error)) {
    return {
      headline: "This reading came back empty",
      facts: [],
      note: String(result.error),
    };
  }
  if (!isRec(result)) return generic(tool, result);

  switch (tool) {
    case "read_timeseries":
      return timeseries(result, a);
    case "read_value":
      return pointValue(result, a);
    case "read_assessment":
      return assessment(result, a);
    case "read_events":
      return events(result, a);
    case "read_profile":
      return profile(result, a);
    case "read_instruments":
      return instruments(result);
    case "read_catalog":
      return catalog(result);
    default:
      return generic(tool, result);
  }
}
