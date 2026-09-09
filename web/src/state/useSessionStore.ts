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

  // --- current field selection ---
  variable: string;
  depth: number;
  timeIndex: number;

  // --- region selection ---
  selection: BBox | null;
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
  opacity: number;

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
  setVariable: (v: string) => void;
  setDepth: (d: number) => void;
  setTimeIndex: (i: number) => void;
  setSelection: (b: BBox | null) => void;
  setDepthRange: (r: [number, number]) => void;
  setPhase: (p: TransitionPhase) => void;
  setBlockProgress: (v: number) => void;
  setExaggeration: (v: number) => void;
  setOpacity: (v: number) => void;
  setIsoLevel: (v: number) => void;
  toggle: (
    key: "showVolume" | "showSlice" | "showParticles" | "showIsosurface" | "playing",
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

  variable: "temperature",
  depth: 0,
  timeIndex: 0,

  selection: null,
  depthRange: [0, 2000],

  phase: "map",
  blockProgress: 0,

  exaggeration: 3,
  showVolume: true,
  showSlice: true,
  showParticles: true,
  showIsosurface: false,
  isoLevel: 20,
  opacity: 0.85,

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
  setVariable: (variable) => set({ variable }),
  setDepth: (depth) => set({ depth }),
  setTimeIndex: (timeIndex) => set({ timeIndex }),
  setSelection: (selection) => set({ selection }),
  setDepthRange: (depthRange) => set({ depthRange }),
  setPhase: (phase) => set({ phase }),
  setBlockProgress: (blockProgress) => set({ blockProgress }),
  setExaggeration: (exaggeration) => set({ exaggeration }),
  setOpacity: (opacity) => set({ opacity }),
  setIsoLevel: (isoLevel) => set({ isoLevel }),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<SessionState>),
  setObservations: (observations) => set({ observations }),
  setErrorById: (errorById) => set({ errorById }),
  setSelectedProfile: (selectedProfile) => set({ selectedProfile }),
  setMatchup: (matchup) => set({ matchup }),
  setLoadingProfile: (loadingProfile) => set({ loadingProfile }),

  applyPreset: (p) =>
    set({ selection: p.bbox as BBox, depthRange: p.depthRange as [number, number] }),

  reset: () =>
    set({
      phase: "map",
      blockProgress: 0,
      selection: null,
      selectedProfile: null,
      matchup: null,
      playing: false,
    }),
}));

/** Current ISO timestamp, or undefined when the catalog has not loaded yet. */
export const currentTime = (s: SessionState): string | undefined =>
  s.times.length ? s.times[Math.min(s.timeIndex, s.times.length - 1)] : undefined;

export const currentVariable = (s: SessionState): VariableSummary | undefined =>
  s.variables.find((v) => v.variable === s.variable);
