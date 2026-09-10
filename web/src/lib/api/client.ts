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
  CoverageResponse,
  EventsResponse,
  InstrumentQueryResponse,
  ObservationProfile,
  ParserCapabilities,
  ChatEvent,
  ChatResponse,
  ChatView,
  ProvenanceResponse,
  QueryResponse,
  QueryStatus,
  RegionPreset,
  SectionResponse,
  SliceResponse,
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

export interface SectionRequest {
  variable: string;
  /** Two or more [lon, lat] waypoints. Two is a straight transect. */
  path: [number, number][];
  depthRange: [number, number];
  time?: string;
  samples?: number;
}

function sectionQuery(opts: SectionRequest): string {
  const pt = (p: [number, number]) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const q = new URLSearchParams({
    var: opts.variable,
    // Always `path`, even for two points: a second parameter form on the
    // client would mean two ways to express the same request and two chances
    // for the image and the geometry to disagree about the track.
    path: opts.path.map(pt).join(";"),
    depthRange: opts.depthRange.join(","),
    samples: String(opts.samples ?? 192),
  });
  if (opts.time) q.set("time", opts.time);
  return `/api/section?${q}`;
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

  /**
   * Exceedance events, for replay and for the extremes layer.
   *
   * 404s when the catalogue carries no climatology, which is a legitimate
   * configuration rather than an error -- callers treat it as "no events".
   */
  events: (
    opts: { bbox?: BBox; variable: string; depth?: number; threshold?: number },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({ var: opts.variable });
    if (opts.bbox) p.set("bbox", bboxParam(opts.bbox));
    if (opts.depth !== undefined) p.set("depth", String(opts.depth));
    if (opts.threshold) p.set("threshold", String(opts.threshold));
    return getJSON<EventsResponse>(`/api/events?${p}`, signal);
  },

  /**
   * Interpret a phrase as tool calls (spec 5.2).
   *
   * POST, not GET: the phrase is a body rather than a URL, so it never lands
   * in a browser history entry, a proxy log or a shared permalink. A search
   * box that quietly writes what people typed into the address bar is a
   * different product than the one we are shipping.
   */
  query: (phrase: string, signal?: AbortSignal) =>
    fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: phrase }),
      signal,
    }).then((r) => r.json() as Promise<QueryResponse>),

  /**
   * A conversation turn. The whole history is posted each time: the model is
   * stateless, and a server-side session would need eviction and identity for
   * no gain.
   */
  chat: (
    messages: { role: string; content: string }[],
    view?: ChatView,
    signal?: AbortSignal,
  ) =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, view }),
      signal,
    }).then((r) => r.json() as Promise<ChatResponse>),

  /**
   * The same conversation, reported as it happens.
   *
   * NDJSON read off the body stream rather than EventSource: EventSource
   * cannot POST, and the conversation has to go in a body -- a question in a
   * query string would land in history, proxy logs and any shared link.
   *
   * `onEvent` is called for every line; the promise resolves with the final
   * one. A partial line is held back until its newline arrives, because a
   * chunk boundary lands mid-object often enough to matter.
   */
  chatStream: async (
    messages: { role: string; content: string }[],
    view: ChatView | undefined,
    onEvent: (e: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse | null> => {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, view }),
      signal,
    });
    if (!res.body) throw new Error("no response stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: ChatResponse | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        let event: ChatEvent;
        try {
          event = JSON.parse(text) as ChatEvent;
        } catch {
          // A malformed line must not abandon a conversation that is
          // otherwise fine; the final event is what the caller needs.
          continue;
        }
        onEvent(event);
        if (event.type === "final") final = event;
      }
    }
    return final;
  },

  queryStatus: (signal?: AbortSignal) =>
    getJSON<QueryStatus>("/api/query/status", signal),

  provenance: (signal?: AbortSignal) =>
    getJSON<ProvenanceResponse>("/api/provenance", signal),

  /**
   * The Level 2 assessment grid: coverage, blind spots, accuracy, confidence
   * and freshness in one payload. The client chooses which property to colour
   * by; the server never needs to know which layer is on screen.
   */
  coverage: (
    opts: { bbox?: BBox; variable: string; windowDays?: number; cell?: number },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({ var: opts.variable });
    if (opts.bbox) p.set("bbox", bboxParam(opts.bbox));
    if (opts.windowDays) p.set("windowDays", String(opts.windowDays));
    if (opts.cell) p.set("cell", String(opts.cell));
    return getJSON<CoverageResponse>(`/api/coverage?${p}`, signal);
  },

  /**
   * Rank instruments -- `query_floats` from spec 5.2.
   *
   * Server-side on purpose: "which floats disagree most with the model" is a
   * measurement over the observation index, and a language layer that answered
   * it from its own knowledge would be generating a scientific claim.
   */
  instruments: (
    opts: {
      sortBy: "trajectory_length" | "model_error" | "recency" | "profile_count";
      order?: "desc" | "asc";
      limit?: number;
      platform?: string;
      bbox?: BBox;
      variable?: string;
    },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({ sortBy: opts.sortBy });
    if (opts.order) p.set("order", opts.order);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.platform) p.set("platform", opts.platform);
    if (opts.bbox) p.set("bbox", bboxParam(opts.bbox));
    if (opts.variable) p.set("var", opts.variable);
    return getJSON<InstrumentQueryResponse>(`/api/instruments?${p}`, signal);
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

  /**
   * One depth level as a JSON grid.
   *
   * `res` caps the returned grid, which is what makes the pointer readout
   * affordable: one coarse grid covering the whole dataset extent is fetched
   * per (variable, depth, time) and sampled locally, instead of a request per
   * pointer move.
   */
  slice: (
    opts: { variable: string; depth: number; time?: string; res?: number; bbox?: BBox },
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams({ var: opts.variable, depth: String(opts.depth) });
    if (opts.time) p.set("time", opts.time);
    if (opts.res) p.set("res", String(opts.res));
    if (opts.bbox) p.set("bbox", bboxParam(opts.bbox));
    return getJSON<SliceResponse>(`/api/slice?${p}`, signal);
  },

  /**
   * Coastline traced from the bathymetry, as GeoJSON.
   *
   * There is deliberately no remote basemap (a stalled style leaves MapLibre
   * permanently unloaded), so geographic context comes from the same elevation
   * field the seabed mesh uses -- consistent with the block by construction,
   * and with no third-party tiles to fail on conference wifi.
   */
  coastline: (signal?: AbortSignal) =>
    getJSON<GeoJSON.FeatureCollection & { synthetic: boolean; note: string }>(
      "/api/coastline",
      signal,
    ),

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
    // Must match the volume LOD on screen: both are positioned by normalized
    // level index, so a different depth decimation shifts the surface.
    res?: "coarse" | "full";
  }) => {
    const p = new URLSearchParams({
      var: opts.variable,
      bbox: bboxParam(opts.bbox),
      depthRange: opts.depthRange.join(","),
      level: String(opts.level),
    });
    if (opts.time) p.set("time", opts.time);
    if (opts.res) p.set("res", opts.res);
    return `/api/isosurface?${p}`;
  },

  section: (opts: SectionRequest, signal?: AbortSignal) =>
    getJSON<SectionResponse>(sectionQuery(opts), signal),

  sectionPngUrl: (
    opts: SectionRequest & {
      display?: { range?: [number, number]; log?: boolean; colormap?: string };
    },
  ) => {
    let url = `${sectionQuery(opts)}&fmt=png`;
    const d = opts.display;
    if (d) {
      const p = new URLSearchParams();
      if (d.range) {
        p.set("vmin", String(d.range[0]));
        p.set("vmax", String(d.range[1]));
      }
      if (d.log !== undefined) p.set("log", String(d.log));
      if (d.colormap) p.set("cmap", d.colormap);
      const qs = p.toString();
      if (qs) url += `&${qs}`;
    }
    return url;
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

  /**
   * Anomaly-vs-climatology tiles.
   *
   * A separate template from `tileUrl`, not a flag: the anomaly is drawn with
   * a diverging colormap on a symmetric range so the SIGN is readable, which
   * the variable's own sequential colormap and range cannot express.
   */
  anomalyTileUrl: (
    variable: string,
    time: string,
    depth: number,
    limit = 3,
  ) =>
    `/tiles/anomaly/${variable}/${encodeURIComponent(time || "latest")}/${depth}` +
    `/{z}/{x}/{y}.png?limit=${limit}`,

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
