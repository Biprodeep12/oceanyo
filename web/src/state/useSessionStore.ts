"use client";

// One store, read by both renderers.
//
// Zustand rather than Context/Redux because the r3f render loop reads camera,
// depth, exaggeration and colorbar state inside useFrame at 60fps.
// `getState()` and transient `subscribe()` do that WITHOUT triggering a React
// re-render; a Context would re-render the tree on every frame of the extrude
// tween, which is exactly the stutter that ruins the transition.
//
// Binary payloads and GPU handles are deliberately NOT kept here -- see
// lib/loading/volumeStore.ts. A re-render that drops a texture reference
// without disposing it will crash a laptop mid-demo.

import { create } from "zustand";

import { applyTheme, type Theme } from "@/lib/theme";
import type {
  BBox,
  CoverageMetric,
  CoverageResponse,
  EventsResponse,
  HealthResponse,
  MatchupResult,
  ObservationFeature,
  ObservationProfile,
  RegionPreset,
  VariableSummary,
} from "@/lib/api/types";

/**
 * Waypoints a transect may carry.
 *
 * The server caps this too; the number is here as well because the UI has to
 * say what the limit is before it is hit, and a cap discovered only by a 422
 * is a cap that reads as a bug.
 */
export const MAX_SECTION_POINTS = 8;

/**
 * map -> framing -> extruding -> holding -> block, and back.
 *
 * "framing" is the map centring the selection before it hands over. It is a
 * phase rather than a local flag because the Dive button, the hints and the
 * renderer visibility all have to agree that a dive has started while the MAP
 * is still the thing on screen.
 */
export type TransitionPhase =
  | "map"
  | "arming"
  | "framing"
  | "extruding"
  | "holding"
  | "block"
  | "returning";

export interface SessionState {
  // --- catalog ---
  health: HealthResponse | null;
  variables: VariableSummary[];
  presets: RegionPreset[];
  times: string[];
  /** Full extent this catalog can serve; drives the locator inset. */
  domain: BBox | null;
  /** Shared with the locator inset so the coastline is fetched once. */
  coastline: GeoJSON.FeatureCollection | null;
  /** Timesteps whose coarse volume is already decoded and on the GPU. */
  bufferedTimes: string[];
  theme: Theme;

  // --- current field selection ---
  variable: string;
  depth: number;
  timeIndex: number;

  // --- region selection ---
  selection: BBox | null;
  /**
   * Tap-to-draw mode. Shift+drag is impossible on a touch screen, so a region
   * can also be set by tapping two opposite corners. Available everywhere, not
   * just on mobile -- it is the discoverable way to do it either way.
   */
  drawMode: boolean;
  /**
   * What the next draw produces.
   *
   * "rect" is the axis-aligned bbox everything server-side speaks; "quad" adds
   * four freely placed corners on top of it. The quad does NOT replace the
   * bbox -- `selection` stays the quad's bounding box, so every field, volume,
   * section and matchup request is unchanged and there is no second server
   * path to keep in step. The quad is a CLIP, applied where the geometry is
   * built, which is the only place it can be honoured without teaching xarray
   * about polygons.
   */
  drawShape: "rect" | "quad";
  /** Four [lon, lat] corners in order, or null for a plain rectangle. */
  selectionQuad: [number, number][] | null;
  /** Layers sheet visibility; only consulted on a phone. */
  layersOpen: boolean;
  /**
   * Assistant panel visibility.
   *
   * In the store rather than in the page because three components need it: the
   * page mounts the panel, the rail highlights its button, and the profile
   * panel has to step aside so the two do not occupy the same slot.
   */
  assistantOpen: boolean;
  /** First corner tapped, while the second is still to come. */
  drawAnchor: [number, number] | null;
  depthRange: [number, number];

  // --- mode / transition ---
  phase: TransitionPhase;
  blockProgress: number; // 0 = flat map, 1 = full block

  // --- rendering ---
  exaggeration: number;
  showVolume: boolean;
  showSlice: boolean;
  showParticles: boolean;
  showIsosurface: boolean;
  isoLevel: number;
  /** Instrument markers on the map and in the block. */
  showObservations: boolean;
  /** Climatology anomaly overlay in map mode. */
  showAnomaly: boolean;
  /**
   * Which assessment layer is on the map, or null for none.
   *
   * One value rather than six booleans: coverage, blind spots, accuracy, bias,
   * confidence and freshness all colour the SAME grid, so two of them on at
   * once would just be one hiding the other.
   */
  coverageMetric: CoverageMetric | null;
  coverage: CoverageResponse | null;
  loadingCoverage: boolean;
  /**
   * Exceedance events in the record. Held in the store rather than in the
   * popover that lists them, because the timeline draws them too -- an event
   * the user can see on the scrubber is one they can find again after the
   * popover closes.
   */
  events: EventsResponse | null;
  /** Colour saturation of the anomaly layer, in standard deviations. */
  anomalyLimit: number;
  /**
   * Colour of the seabed and the land it rises into, in block mode.
   *
   * A setting rather than a constant because the right answer depends on what
   * is being read: earth tones look like a seabed and disappear against a warm
   * volume; a neutral grey stays legible under every colormap; near-black is
   * what you want for a screenshot where only the water should draw the eye.
   */
  seabedColor: string;
  /** Vertical cross-section curtain in block mode. */
  showSection: boolean;
  /** The two [lon, lat] endpoints; a section needs both. */
  sectionPoints: [number, number][];
  opacity: number;
  /** Colour range override per variable; absent = the variable's own range. */
  colorRange: Record<string, [number, number]>;
  logScale: Record<string, boolean>;
  colormapOverride: Record<string, string>;

  // --- observations ---
  observations: ObservationFeature[];
  /** How many the index held, when that exceeds what was fetched. */
  observationsTotal: number;
  errorById: Record<string, number>; // id -> |bias|, colours the instruments
  selectedProfile: ObservationProfile | null;
  matchup: MatchupResult | null;
  loadingProfile: boolean;

  // --- playback ---
  playing: boolean;

  // --- actions ---
  setHealth: (h: HealthResponse) => void;
  setVariables: (v: VariableSummary[]) => void;
  setPresets: (p: RegionPreset[]) => void;
  setTimes: (t: string[]) => void;
  setDomain: (b: BBox | null) => void;
  setCoverageMetric: (m: CoverageMetric | null) => void;
  setCoverage: (c: CoverageResponse | null) => void;
  setLoadingCoverage: (v: boolean) => void;
  setEvents: (e: EventsResponse | null) => void;
  setCoastline: (fc: GeoJSON.FeatureCollection | null) => void;
  setBufferedTimes: (t: string[]) => void;
  setTheme: (t: Theme) => void;
  setVariable: (v: string) => void;
  setDepth: (d: number) => void;
  setTimeIndex: (i: number) => void;
  setSelection: (b: BBox | null) => void;
  /** Drop the drawn region and everything anchored to it. */
  clearSelection: () => void;
  setDrawMode: (v: boolean) => void;
  setDrawShape: (v: "rect" | "quad") => void;
  setSelectionQuad: (q: [number, number][] | null) => void;
  setLayersOpen: (v: boolean) => void;
  setAssistantOpen: (v: boolean) => void;
  setDrawAnchor: (p: [number, number] | null) => void;
  setDepthRange: (r: [number, number]) => void;
  setPhase: (p: TransitionPhase) => void;
  setBlockProgress: (v: number) => void;
  setExaggeration: (v: number) => void;
  setOpacity: (v: number) => void;
  setIsoLevel: (v: number) => void;
  setAnomalyLimit: (v: number) => void;
  setSeabedColor: (c: string) => void;
  addSectionPoint: (lon: number, lat: number) => void;
  undoSectionPoint: () => void;
  clearSection: () => void;
  setColorRange: (variable: string, range: [number, number] | null) => void;
  setLogScale: (variable: string, log: boolean | null) => void;
  setColormap: (variable: string, cmap: string | null) => void;
  toggle: (
    key:
      | "showVolume"
      | "showSlice"
      | "showParticles"
      | "showIsosurface"
      | "showObservations"
      | "showAnomaly"
      | "showSection"
      | "playing",
  ) => void;
  setObservations: (f: ObservationFeature[], total?: number) => void;
  setErrorById: (m: Record<string, number>) => void;
  setSelectedProfile: (p: ObservationProfile | null) => void;
  setMatchup: (m: MatchupResult | null) => void;
  setLoadingProfile: (v: boolean) => void;
  applyPreset: (p: RegionPreset) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  health: null,
  variables: [],
  presets: [],
  times: [],
  domain: null,
  coastline: null,
  // Dark until the client reports otherwise; see initialTheme().
  bufferedTimes: [],
  theme: "dark" as Theme,

  variable: "temperature",
  depth: 0,
  timeIndex: 0,

  selection: null,
  drawMode: false,
  drawShape: "rect" as const,
  selectionQuad: null,
  drawAnchor: null,
  layersOpen: false,
  assistantOpen: false,
  depthRange: [0, 2000],

  phase: "map",
  blockProgress: 0,

  exaggeration: 3,
  showVolume: true,
  showSlice: true,
  showParticles: true,
  showIsosurface: false,
  isoLevel: 20,
  showObservations: true,
  showAnomaly: false,
  anomalyLimit: 3,
  seabedColor: "#5a4a3d",
  coverageMetric: null,
  coverage: null,
  loadingCoverage: false,
  events: null,
  showSection: false,
  sectionPoints: [],
  opacity: 0.85,
  colorRange: {},
  logScale: {},
  colormapOverride: {},

  observations: [],
  observationsTotal: 0,
  errorById: {},
  selectedProfile: null,
  matchup: null,
  loadingProfile: false,

  playing: false,

  setHealth: (health) => set({ health }),
  setVariables: (variables) => set({ variables }),
  setPresets: (presets) => set({ presets }),
  setTimes: (times) => set({ times }),
  setDomain: (domain) => set({ domain }),
  setCoverageMetric: (coverageMetric) => set({ coverageMetric }),
  setCoverage: (coverage) => set({ coverage }),
  setLoadingCoverage: (loadingCoverage) => set({ loadingCoverage }),
  setEvents: (events) => set({ events }),
  setCoastline: (coastline) => set({ coastline }),
  setBufferedTimes: (bufferedTimes) => set({ bufferedTimes }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  setVariable: (variable) => set({ variable }),
  setDepth: (depth) => set({ depth }),
  setTimeIndex: (timeIndex) => set({ timeIndex }),
  // Setting a plain rectangle clears any quad. Otherwise the block would go
  // on clipping to a shape the map has stopped drawing -- data would appear to
  // be missing from a region that was just selected.
  setSelection: (selection) => set({ selection, selectionQuad: null }),
  // Deselecting is not just `selection: null`. A half-drawn rectangle, a quad
  // from a previous shape and a cross-section anchored to the old region all
  // belong to the selection that is being thrown away, and leaving any of them
  // behind means the next drag starts from someone else's corner.
  clearSelection: () =>
    set({
      selection: null,
      selectionQuad: null,
      drawAnchor: null,
      drawMode: false,
      sectionPoints: [],
      showSection: false,
    }),
  setDrawMode: (drawMode) => set({ drawMode, drawAnchor: null }),
  setDrawShape: (drawShape) => set({ drawShape, drawAnchor: null }),
  setSelectionQuad: (selectionQuad) => set({ selectionQuad }),
  setDrawAnchor: (drawAnchor) => set({ drawAnchor }),
  setLayersOpen: (layersOpen) => set({ layersOpen }),
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  setDepthRange: (depthRange) => set({ depthRange }),
  setPhase: (phase) => set({ phase }),
  setBlockProgress: (blockProgress) => set({ blockProgress }),
  setExaggeration: (exaggeration) => set({ exaggeration }),
  setOpacity: (opacity) => set({ opacity }),
  setIsoLevel: (isoLevel) => set({ isoLevel }),
  setAnomalyLimit: (anomalyLimit) => set({ anomalyLimit }),
  setSeabedColor: (seabedColor) => set({ seabedColor }),

  // Each click EXTENDS the transect. Two points is the straight section the
  // spec asks for in the MVP; more of them follow a channel, a coastline or a
  // float track, which is the Level 2 "arbitrary transect" and is the same
  // request with more waypoints rather than a second tool.
  //
  // At the cap a further click moves the last point instead of being ignored,
  // so the end of a long transect can still be adjusted without clearing it.
  addSectionPoint: (lon, lat) =>
    set((st) => {
      const pts = st.sectionPoints;
      if (pts.length >= MAX_SECTION_POINTS) {
        return { sectionPoints: [...pts.slice(0, -1), [lon, lat]] };
      }
      return { sectionPoints: [...pts, [lon, lat]] };
    }),
  undoSectionPoint: () =>
    set((st) => ({ sectionPoints: st.sectionPoints.slice(0, -1) })),
  clearSection: () => set({ sectionPoints: [] }),

  setColorRange: (variable, range) =>
    set((st) => {
      const next = { ...st.colorRange };
      if (range) next[variable] = range;
      else delete next[variable];
      return { colorRange: next };
    }),
  setLogScale: (variable, log) =>
    set((st) => {
      const next = { ...st.logScale };
      if (log === null) delete next[variable];
      else next[variable] = log;
      return { logScale: next };
    }),
  setColormap: (variable, cmap) =>
    set((st) => {
      const next = { ...st.colormapOverride };
      if (cmap === null) delete next[variable];
      else next[variable] = cmap;
      return { colormapOverride: next };
    }),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<SessionState>),
  setObservations: (observations, total) =>
    set({ observations, observationsTotal: total ?? observations.length }),
  setErrorById: (errorById) => set({ errorById }),
  setSelectedProfile: (selectedProfile) => set({ selectedProfile }),
  setMatchup: (matchup) => set({ matchup }),
  setLoadingProfile: (loadingProfile) => set({ loadingProfile }),

  // Clears the quad for the same reason setSelection does: a preset replaces
  // the region, and a stale clip would hide part of the one just chosen.
  applyPreset: (p) =>
    set({
      selection: p.bbox as BBox,
      depthRange: p.depthRange as [number, number],
      selectionQuad: null,
    }),

  // Returning to the map KEEPS the selection. The next thing anyone does after
  // coming back up is dive again -- with another variable, another depth range,
  // or a nudged corner -- and clearing the rectangle forced them to redraw it
  // every time. What is cleared is everything that belonged to the block.
  reset: () =>
    set({
      phase: "map",
      blockProgress: 0,
      drawMode: false,
      drawAnchor: null,
      selectedProfile: null,
      matchup: null,
      playing: false,
      sectionPoints: [],
      showSection: false,
      bufferedTimes: [],
    }),
}));

/** Current ISO timestamp, or undefined when the catalog has not loaded yet. */
export const currentTime = (s: SessionState): string | undefined =>
  s.times.length ? s.times[Math.min(s.timeIndex, s.times.length - 1)] : undefined;

export const currentVariable = (s: SessionState): VariableSummary | undefined =>
  s.variables.find((v) => v.variable === s.variable);

// NOTE: effective colour settings live in useDisplaySettings.ts, not here.
// A selector that builds an object per call breaks zustand's equality check
// and loops forever -- see the comment in that file.
