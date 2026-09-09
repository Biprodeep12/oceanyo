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
 * GET /api/section -- a vertical curtain between two points.
 *
 * `depths` are the model's OWN levels, not an evenly spaced axis, and rows of
 * `values` follow them shallowest-first. The client places each row by index
 * so the curtain shares the block's vertical axis with the volume.
 */
export interface SectionResponse {
  variable: string;
  units: string;
  p0: [number, number];
  p1: [number, number];
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
