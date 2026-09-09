// All requests are relative paths. Next rewrites proxy /api, /tiles, /wms and
// /opendap to the FastAPI process, so everything is same-origin: no CORS, no
// preflight on binary bodies, and AbortController behaves identically in dev
// and production.

import type {
  BathymetryResponse,
  BBox,
  CurrentsMeta,
  GriddedField,
  HealthResponse,
  MatchupResult,
  MatchupSummaryRow,
  ObservationCollection,
  ObservationProfile,
  ParserCapabilities,
  RegionPreset,
  VariableSummary,
} from "./types";

const bboxParam = (b: BBox) => b.map((v) => v.toFixed(4)).join(",");

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${res.status} ${url.split("?")[0]}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => getJSON<HealthResponse>("/api/health", signal),

  variables: (signal?: AbortSignal) =>
    getJSON<VariableSummary[]>("/api/variables", signal),

  metadata: (variable: string, signal?: AbortSignal) =>
    getJSON<GriddedField>(`/api/metadata/${variable}`, signal),

  presets: (signal?: AbortSignal) =>
    getJSON<{ presets: RegionPreset[] }>("/api/presets", signal).then((d) => d.presets),

  platforms: (signal?: AbortSignal) =>
    getJSON<ParserCapabilities[]>("/api/platforms", signal),

  observations: (
    opts: { bbox?: BBox; platform?: string; limit?: number },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams();
    if (opts.bbox) p.set("bbox", bboxParam(opts.bbox));
    if (opts.platform) p.set("platform", opts.platform);
    if (opts.limit) p.set("limit", String(opts.limit));
    return getJSON<ObservationCollection>(`/api/observations?${p}`, signal);
  },

  profile: (platform: string, id: string, signal?: AbortSignal) =>
    getJSON<ObservationProfile>(
      `/api/profile/${platform}/${encodeURIComponent(id)}`,
      signal,
    ),

  matchup: (
    opts: { platform: string; id: string; variable: string; radius?: number },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({
      platform: opts.platform,
      id: opts.id,
      var: opts.variable,
    });
    if (opts.radius) p.set("radius", String(opts.radius));
    return getJSON<MatchupResult>(`/api/matchup?${p}`, signal);
  },

  matchupSummary: (
    opts: { bbox?: BBox; variable: string; platform?: string; limit?: number },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({ var: opts.variable });
    if (opts.bbox) p.set("bbox", bboxParam(opts.bbox));
    if (opts.platform) p.set("platform", opts.platform);
    if (opts.limit) p.set("limit", String(opts.limit));
    return getJSON<{ results: MatchupSummaryRow[]; scored: number; count: number }>(
      `/api/matchup/summary?${p}`,
      signal,
    );
  },

  bathymetry: (bbox: BBox, res: number, signal?: AbortSignal) =>
    getJSON<BathymetryResponse>(
      `/api/bathymetry?bbox=${bboxParam(bbox)}&res=${res}`,
      signal,
    ),

  currentsMeta: (
    opts: { bbox: BBox; depth: number; time?: string; res?: number },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({
      bbox: bboxParam(opts.bbox),
      depth: String(opts.depth),
      fmt: "meta",
    });
    if (opts.time) p.set("time", opts.time);
    if (opts.res) p.set("res", String(opts.res));
    return getJSON<CurrentsMeta>(`/api/currents?${p}`, signal);
  },

  currentsPngUrl: (opts: { bbox: BBox; depth: number; time?: string; res?: number }) => {
    const p = new URLSearchParams({
      bbox: bboxParam(opts.bbox),
      depth: String(opts.depth),
    });
    if (opts.time) p.set("time", opts.time);
    if (opts.res) p.set("res", String(opts.res));
    return `/api/currents?${p}`;
  },

  timestep: (
    opts: { variable: string; bbox: BBox; depth: number },
    signal?: AbortSignal,
  ) =>
    getJSON<{
      times: string[];
      mean: (number | null)[];
      min: (number | null)[];
      max: (number | null)[];
      units: string;
    }>(
      `/api/timestep?var=${opts.variable}&bbox=${bboxParam(opts.bbox)}&depth=${opts.depth}`,
      signal,
    ),

  isosurfaceUrl: (opts: {
    variable: string;
    bbox: BBox;
    depthRange: [number, number];
    level: number;
    time?: string;
  }) => {
    const p = new URLSearchParams({
      var: opts.variable,
      bbox: bboxParam(opts.bbox),
      depthRange: opts.depthRange.join(","),
      level: String(opts.level),
    });
    if (opts.time) p.set("time", opts.time);
    return `/api/isosurface?${p}`;
  },

  volumeUrl: (opts: {
    variable: string;
    bbox: BBox;
    depthRange: [number, number];
    time?: string;
    res: "coarse" | "full";
  }) => {
    const p = new URLSearchParams({
      var: opts.variable,
      bbox: bboxParam(opts.bbox),
      depthRange: opts.depthRange.join(","),
      res: opts.res,
    });
    if (opts.time) p.set("time", opts.time);
    return `/api/volume?${p}`;
  },

  tileUrl: (
    variable: string,
    time: string,
    depth: number,
    display?: { range?: [number, number]; log?: boolean; colormap?: string },
  ) => {
    const base = `/tiles/${variable}/${encodeURIComponent(time || "latest")}/${depth}/{z}/{x}/{y}.png`;
    if (!display) return base;
    const p = new URLSearchParams();
    if (display.range) {
      p.set("vmin", String(display.range[0]));
      p.set("vmax", String(display.range[1]));
    }
    if (display.log !== undefined) p.set("log", String(display.log));
    if (display.colormap) p.set("cmap", display.colormap);
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  },
};
