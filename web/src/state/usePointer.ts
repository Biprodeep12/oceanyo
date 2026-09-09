"use client";

// Pointer readout state, deliberately in its own store.
//
// This updates on every mouse move over the map. Putting it in the session
// store would re-render every component subscribed to anything -- the whole
// left panel, the timeline, the rail -- sixty times a second. Isolated here,
// only the two small components that display it re-render.

import { create } from "zustand";

export interface PointerState {
  /** Screen position, for the bubble. */
  x: number;
  y: number;
  lon: number;
  lat: number;
  /** Sampled field value at the cursor, or null where there is no data. */
  value: number | null;
  units: string;
  label: string;
  visible: boolean;
  set: (p: Partial<Omit<PointerState, "set" | "clear">>) => void;
  clear: () => void;
}

export const usePointer = create<PointerState>((set) => ({
  x: 0,
  y: 0,
  lon: 0,
  lat: 0,
  value: null,
  units: "",
  label: "",
  visible: false,
  set: (p) => set(p),
  clear: () => set({ visible: false }),
}));

/** Degrees to the degrees-and-minutes form the map corner conventionally uses. */
export function formatLatLon(lat: number, lon: number): string {
  const dm = (v: number, pos: string, neg: string) => {
    const hemi = v >= 0 ? pos : neg;
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.round((a - d) * 60);
    // 59.6' rounds to 60': carry into the degree rather than printing 60.
    const carry = m === 60 ? 1 : 0;
    return `${d + carry}° ${String(m - carry * 60).padStart(2, "0")}' ${hemi}`;
  };
  return `${dm(lat, "N", "S")}  ${dm(lon, "E", "W")}`;
}
