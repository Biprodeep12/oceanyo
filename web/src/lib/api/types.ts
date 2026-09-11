// Mirrors backend/app/core/models.py field for field. The Python side is the
// source of truth; if these drift, the block will render nonsense rather than
// fail loudly, so keep them in step.

export type Mode = "map" | "block";

export interface VariableSummary {
  variable: string;
  standardName: string;
  units: string;
  longName: string;
  depthRange: [number, number];
  timeRange: [string, string];
  validRange: [number, number];
  colormap: string;
  log: boolean;
  /** What the variable actually spans in this catalogue, dataset-wide. */
  dataRange?: [number, number];
}

export interface GriddedField {
  variable: string;
  standardName: string;
  units: string;
  lat: number[];
  lon: number[];
  depth: number[];
  time: string[];
  shape: [number, number, number, number];
  source: string;
  synthetic: boolean;
}

export interface HealthResponse {
  status: string;
  catalogId: string;
  synthetic: boolean;
  source: string;
  variables: string[];
  platforms: string[];
  standards: Record<string, boolean>;
  /** Whether the query layer can reach a model. False is normal. */
  nlq?: boolean;
  /** Variables this catalog can produce a climatology anomaly for. */
  climatology: string[];
}

export interface ProfileVariable {
  units: string;
  values: (number | null)[];
  qc: number[];
}

export interface ObservationProfile {
  platform: string;
  id: string;
  lat: number;
  lon: number;
  time: string;
  depth: number[];
  variables: Record<string, ProfileVariable>;
  trajectory?: { lat: number; lon: number; time: string }[];
  dataMode: "R" | "A" | "D";
  source: string;
}

export interface MatchupResult {
  platform: string;
  id: string;
  variable: string;
  obsDepths: number[];
  obsValues: number[];
  modelValues: (number | null)[];
  bias: number | null;
  rmse: number | null;
  mae: number | null;
  corr: number | null;
  n: number;
  stdObs: number | null;
  stdModel: number | null;
  crmse: number | null;
  radiusKm: number;
  windowHours: number;
  qcFlagsUsed: number[];
  modelSource: string;
  obsDataMode: string;
}

export interface MatchupSummaryRow {
  platform: string;
  id: string;
  lat: number;
  lon: number;
  time: string;
  dataMode: string;
  bias: number | null;
  rmse: number | null;
  n: number;
}

export interface ParserCapabilities {
  platform: string;
  variables: string[];
  depthRange: [number, number];
  hasTrajectory: boolean;
  qcScheme: string;
  dataModes: string[];
  description: string;
}

export interface RegionPreset {
  id: string;
  label: string;
  bbox: [number, number, number, number];
  depthRange: [number, number];
  note?: string;
}

export interface ObservationFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    platform: string;
    id: string;
    time: string;
    dataMode: string;
  };
}

export interface ObservationCollection {
  type: "FeatureCollection";
  count: number;
  /** How many matched before `limit` was applied. */
  total?: number;
  truncated?: boolean;
  features: ObservationFeature[];
}

export interface BathymetryResponse {
  bbox: [number, number, number, number];
  shape: [number, number]; // lat, lon
  min: number;
  max: number;
  units: string;
  positive: string;
  elevation: number[][];
}

export interface CurrentsMeta {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  depth: number;
  time: string;
}

/**
 * Header of the binary /api/volume response.
 *
 * IMPORTANT: `dims` is [depth, lat, lon] -- depth-major, end to end. A
 * transposed volume looks like a rendering fault rather than an indexing one,
 * so this order is never rearranged on the client.
 *
 * Raw 0 is reserved for fill/land. WebGL normalizes uint8 to 0..1 on upload,
 * so the shader discards `texel == 0.0` with no separate mask texture.
 *
 * `depths` gives the true depth of each texture layer. Layers are NOT evenly
 * spaced -- the model resolves the upper ocean far more finely -- so the block
 * uses normalized layer index for geometry and labels the axis from `depths`.
 * The isosurface mesh uses the same index space, so the two always align.
 */
export interface VolumeHeader {
  dtype: "uint8" | "uint16";
  scale: number;
  offset: number;
  fillRaw: number;
  dims: [number, number, number];
  bbox: [number, number, number, number];
  depthRange: [number, number];
  depths: number[];
  resolution: "coarse" | "full";
  variable: string;
  time: string;
  vmin: number;
  vmax: number;
}

export interface VolumePayload {
  header: VolumeHeader;
  data: Uint8Array;
}

export type BBox = [number, number, number, number]; // w, s, e, n

/**
 * GET /api/section -- a vertical curtain following a transect.
 *
 * `depths` are the model's OWN levels, not an evenly spaced axis, and rows of
 * `values` follow them shallowest-first. The client places each row by index
 * so the curtain shares the block's vertical axis with the volume.
 */
export interface SectionResponse {
  variable: string;
  units: string;
  /** First and last waypoint, kept for readouts. */
  p0: [number, number];
  p1: [number, number];
  /** Every waypoint, in order. Two for a straight transect. */
  path: [number, number][];
  /** Cumulative distance at each waypoint, so a turn can be marked. */
  vertexKm: number[];
  lengthKm: number;
  time: string;
  shape: [number, number]; // depth, along-track
  distanceKm: number[];
  lon: number[];
  lat: number[];
  depths: number[];
  seabed: (number | null)[] | null;
  vmin: number;
  vmax: number;
  dataRange: [number, number];
  coverage: number;
  values: (number | null)[][];
}

/** GET /api/slice -- one depth level as a JSON grid. */
export interface SliceResponse {
  variable: string;
  units: string;
  depth: number;
  time: string;
  lat: number[];
  lon: number[];
  shape: [number, number];
  vmin: number;
  vmax: number;
  values: (number | null)[][];
}

/**
 * One cell of GET /api/coverage.
 *
 * Five Level-2 map layers read this same feature -- coverage, blind spots,
 * model accuracy, confidence, freshness -- because they are one computation
 * seen from different angles. Splitting them into five endpoints would let the
 * layers disagree about which cell a float falls in.
 */
export interface CoverageCellProps {
  count: number;
  platforms: string[];
  lastTime: string | null;
  /** Days between this cell's newest observation and the model's last step. */
  ageDays: number | null;
  bias: number | null;
  rmse: number | null;
  levels: number;
  /** 0..1: how much evidence there is, times how well it agrees. */
  confidence: number | null;
  ocean: boolean;
  blindSpot: boolean;
}

export interface CoverageSummary {
  variable: string;
  units: string;
  cellDeg: number;
  gridDeg: number | null;
  bbox: BBox;
  cells: number;
  oceanCells: number;
  observedCells: number;
  blindSpots: number;
  coverage: number | null;
  profiles: number;
  scored: number;
  truncated: boolean;
  regionalRmse: number | null;
  sigma: number;
  referenceTime: string | null;
  /** Whether `referenceTime` came from the model record or the float record. */
  referenceSource: "model" | "observations";
  windowDays: number | null;
  maskedByBathymetry: boolean;
  modelSource: string;
}

export interface CoverageResponse {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    geometry: GeoJSON.Polygon;
    properties: CoverageCellProps;
  }[];
  summary: CoverageSummary;
}

/** Which property of a coverage cell drives its colour. */
export type CoverageMetric = "count" | "blindSpot" | "bias" | "rmse" | "confidence" | "ageDays";

export interface ProvenanceDataset {
  role: string;
  file: string;
  path: string;
  variables: string[];
  rawVariables: string[];
  shape: Record<string, number>;
  bbox: BBox;
  timeRange: [string, string] | null;
  steps: number;
  stepHours: number | null;
  attrs: Record<string, string>;
}

export interface ProvenanceResponse {
  catalogId: string;
  source: string;
  synthetic: boolean;
  catalogFile: string;
  datasets: ProvenanceDataset[];
  observations: {
    platform: string;
    parser: string;
    path: string;
    profiles: number;
    latest: string | null;
  }[];
  parsers: ParserCapabilities[];
  disclaimer: string;
}

/** One instrument in GET /api/instruments -- a float or a glider, not a cast. */
export interface InstrumentSummary {
  instrument: string;
  platform: string;
  profiles: number;
  trajectoryKm: number;
  first: string;
  last: string;
  lon: number;
  lat: number;
  dataMode: string;
  meanAbsBias: number | null;
  rmse: number | null;
  matched: number;
  lastProfileId: string;
}

export interface InstrumentQueryResponse {
  sortBy: string;
  order: string;
  variable: string | null;
  instruments: number;
  results: InstrumentSummary[];
}

/**
 * GET /api/events -- runs of timesteps beyond a climatological threshold.
 *
 * Deliberately NOT called marine heatwaves: see `notHobday`, which the server
 * sends with every response so the caveat travels with the numbers.
 */
export interface ExceedanceEvent {
  kind: "warm" | "cool";
  start: string;
  end: string;
  steps: number;
  startIndex: number;
  endIndex: number;
  peakTime: string;
  peakIndex: number;
  peakZ: number;
  peakAnomaly: number;
  peakArea: number;
  severity: number;
}

export interface EventStep {
  time: string;
  meanZ: number;
  meanAnomaly: number;
  warmFraction: number;
  coolFraction: number;
  kind: "warm" | "cool" | null;
}

export interface EventsResponse {
  variable: string;
  units: string;
  depth: number;
  bbox: BBox;
  thresholdZ: number;
  areaFraction: number;
  steps: EventStep[];
  events: ExceedanceEvent[];
  method: string;
  notHobday: string;
}

/**
 * POST /api/query -- a phrase interpreted as tool calls.
 *
 * `tools` is always validated server-side against what this catalogue can
 * actually do, so an empty list is a normal answer and never an error. The
 * model emits calls and nothing else: no value in this response is a
 * measurement, and none is ever displayed as one.
 */
export interface QueryResponse {
  tools: { name: string; args: Record<string, unknown> }[];
  source: "model" | "unavailable" | "error";
  reason: string;
  model: string;
  rejected?: number;
  latencyMs: number;
  config?: { enabled: boolean; hasKey: boolean; baseUrl: string; model: string };
}

export interface QueryStatus {
  available: boolean;
  baseUrl: string;
  model: string;
  enabled: boolean;
  note: string;
}

/**
 * POST /api/chat -- the assistant's answer, and what it is based on.
 *
 * Three separate fields on purpose. `reply` is generated text; `readings` are
 * measured tool results; `actions` are what the view was told to do. The panel
 * renders them differently because spec 5.2 requires measurement and
 * interpretation to be visually separated.
 *
 * `unverified` lists numeric literals in `reply` that appear in NO reading --
 * a number the assistant cannot have measured. Empty is the claim that every
 * number in the answer came from a tool.
 */
export interface ChatReading {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface ChatResponse {
  reply: string;
  error: string;
  readings: ChatReading[];
  actions: { name: string; args: Record<string, unknown> }[];
  unverified: string[];
  rounds: number;
  latencyMs: number;
}

/** What the display currently shows, so "here" and "now" resolve. */
export interface ChatView {
  variable?: string;
  time?: string;
  depth?: number;
  bbox?: BBox;
  mode?: string;
  profile?: string;
}

/**
 * One line of POST /api/chat/stream.
 *
 * The loop reports as it runs because a question costs 18-70 s -- every tool
 * round is a round trip to a free-tier model. "reading the timeseries" is both
 * reassuring and the truest account of where the time went.
 */
export type ChatEvent =
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "reading"; tool: string; args: Record<string, unknown>; result: unknown }
  | { type: "action"; action: { name: string; args: Record<string, unknown> } }
  | ({ type: "final" } & ChatResponse);

/** One selectable dataset from GET /api/catalogs. */
export interface CatalogEntry {
  id: string;
  label: string;
  source: string;
  synthetic: boolean;
  active: boolean;
  /** False when the files this catalog names are not on disk. */
  available: boolean;
  missing: string[];
  /** The command that fetches the missing files. */
  hint: string;
}

export interface CatalogsResponse {
  active: string;
  activeSource: "default" | "selected";
  restart: {
    mode: "exit" | "off";
    supported: boolean;
    reason: string;
    etaSeconds: number;
  };
  catalogs: CatalogEntry[];
}

export interface CatalogSwitchResponse {
  ok: boolean;
  id: string;
  restarting: boolean;
  mode: string;
  etaSeconds: number;
  message: string;
}
