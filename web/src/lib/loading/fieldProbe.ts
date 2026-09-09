"use client";

// One coarse grid per (variable, depth, time), sampled locally.
//
// The pointer readout needs a value under the cursor on every mouse move. A
// request per move would be thousands of round trips; instead one decimated
// grid covering the whole dataset extent is fetched when the selection
// changes, and sampled here. At the demo resolution that is a ~200 KB JSON
// once per variable switch, and nothing at all while the pointer moves.

import { api } from "@/lib/api/client";
import type { SliceResponse } from "@/lib/api/types";

export interface FieldGrid {
  lat: number[];
  lon: number[];
  values: (number | null)[][];
  units: string;
}

const cache = new Map<string, FieldGrid>();
const inflight = new Map<string, Promise<FieldGrid | null>>();

export function probeKey(variable: string, depth: number, time?: string): string {
  return `${variable}|${depth}|${time ?? "latest"}`;
}

export function cachedGrid(key: string): FieldGrid | undefined {
  return cache.get(key);
}

export async function loadGrid(
  key: string,
  opts: { variable: string; depth: number; time?: string; res?: number },
): Promise<FieldGrid | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const task = api
    .slice({ ...opts, res: opts.res ?? 160 })
    .then((r: SliceResponse) => {
      const grid: FieldGrid = {
        lat: r.lat,
        lon: r.lon,
        values: r.values,
        units: r.units,
      };
      cache.set(key, grid);
      // Bounded: a handful of variables times a handful of depths is all a
      // session ever touches, but an unbounded map is still a leak.
      if (cache.size > 24) cache.delete(cache.keys().next().value as string);
      return grid;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/**
 * Bilinear sample at a geographic point; null outside the grid or over land.
 *
 * NaN propagates rather than being treated as zero: a cell touching the
 * seabed mask must read as "no data", not as a value pulled toward zero.
 */
export function sampleGrid(grid: FieldGrid, lon: number, lat: number): number | null {
  const { lat: lats, lon: lons, values } = grid;
  if (!lats.length || !lons.length) return null;
  if (lon < lons[0] || lon > lons[lons.length - 1]) return null;
  if (lat < lats[0] || lat > lats[lats.length - 1]) return null;

  const find = (axis: number[], v: number) => {
    let i = 0;
    while (i < axis.length - 2 && axis[i + 1] < v) i++;
    const span = axis[i + 1] - axis[i];
    return { i, f: span > 1e-12 ? (v - axis[i]) / span : 0 };
  };

  const { i: j, f: fy } = find(lats, lat);
  const { i, f: fx } = find(lons, lon);

  const v00 = values[j]?.[i];
  const v10 = values[j]?.[i + 1];
  const v01 = values[j + 1]?.[i];
  const v11 = values[j + 1]?.[i + 1];
  if (v00 == null || v10 == null || v01 == null || v11 == null) return null;

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}
