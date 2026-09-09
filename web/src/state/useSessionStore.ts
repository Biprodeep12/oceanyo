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
import type {
  BBox,
  HealthResponse,
  MatchupResult,
  ObservationFeature,
  ObservationProfile,
  RegionPreset,
  VariableSummary,
} from "@/lib/api/types";

/** map -> arming -> committing -> extruding -> holding -> block, and back. */
export type TransitionPhase =
  | "map"
  | "arming"
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
  /** Layers sheet visibility; only consulted on a phone. */
  layersOpen: boolean;
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
  /** Colour saturation of the anomaly layer, in standard deviations. */
  anomalyLimit: number;
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
  setCoastline: (fc: GeoJSON.FeatureCollection | null) => void;
  setBufferedTimes: (t: string[]) => void;
  setVariable: (v: string) => void;
  setDepth: (d: number) => void;
  setTimeIndex: (i: number) => void;
  setSelection: (b: BBox | null) => void;
  setDrawMode: (v: boolean) => void;
  setLayersOpen: (v: boolean) => void;
  setDrawAnchor: (p: [number, number] | null) => void;
  setDepthRange: (r: [number, number]) => void;
  setPhase: (p: TransitionPhase) => void;
  setBlockProgress: (v: number) => void;
  setExaggeration: (v: number) => void;
  setOpacity: (v: number) => void;
  setIsoLevel: (v: number) => void;
  setAnomalyLimit: (v: number) => void;
  addSectionPoint: (lon: number, lat: number) => void;
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
  setObservations: (f: ObservationFeature[]) => void;
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
  bufferedTimes: [],

  variable: "temperature",
  depth: 0,
  timeIndex: 0,

  selection: null,
  drawMode: false,
  drawAnchor: null,
  layersOpen: false,
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
  showSection: false,
  sectionPoints: [],
  opacity: 0.85,
  colorRange: {},
  logScale: {},
  colormapOverride: {},

  observations: [],
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
  setCoastline: (coastline) => set({ coastline }),
  setBufferedTimes: (bufferedTimes) => set({ bufferedTimes }),
  setVariable: (variable) => set({ variable }),
  setDepth: (depth) => set({ depth }),
  setTimeIndex: (timeIndex) => set({ timeIndex }),
  setSelection: (selection) => set({ selection }),
  setDrawMode: (drawMode) => set({ drawMode, drawAnchor: null }),
  setDrawAnchor: (drawAnchor) => set({ drawAnchor }),
  setLayersOpen: (layersOpen) => set({ layersOpen }),
  setDepthRange: (depthRange) => set({ depthRange }),
  setPhase: (phase) => set({ phase }),
  setBlockProgress: (blockProgress) => set({ blockProgress }),
  setExaggeration: (exaggeration) => set({ exaggeration }),
  setOpacity: (opacity) => set({ opacity }),
  setIsoLevel: (isoLevel) => set({ isoLevel }),
  setAnomalyLimit: (anomalyLimit) => set({ anomalyLimit }),

  // A third click starts a new section rather than doing nothing: picking is
  // the fiddly part of a transect tool, and re-picking must not need a reset.
  addSectionPoint: (lon, lat) =>
    set((st) => ({
      sectionPoints:
        st.sectionPoints.length >= 2 ? [[lon, lat]] : [...st.sectionPoints, [lon, lat]],
    })),
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
  setObservations: (observations) => set({ observations }),
  setErrorById: (errorById) => set({ errorById }),
  setSelectedProfile: (selectedProfile) => set({ selectedProfile }),
  setMatchup: (matchup) => set({ matchup }),
  setLoadingProfile: (loadingProfile) => set({ loadingProfile }),

  applyPreset: (p) =>
    set({ selection: p.bbox as BBox, depthRange: p.depthRange as [number, number] }),

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
