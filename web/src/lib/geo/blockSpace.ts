"use client";

// Mirrors backend/app/core/geometry.py. Server-produced isosurface meshes are
// already in this space, so the two definitions must not drift.
//
//   x = normalized longitude  [0,1], east positive
//   y = 1 - normalized depth  [0,1], Y-UP so the sea surface sits at y = 1
//   z = normalized latitude   [0,1], north positive
//
// Vertical exaggeration is applied here as a scale on Y, never baked into
// server geometry -- otherwise changing it would refetch every mesh.

import type { BBox } from "@/lib/api/types";

/** Horizontal half-extent of the block in world units. */
export const BLOCK_WIDTH = 2.0;
/** Vertical extent at exaggeration 1. */
export const BLOCK_HEIGHT = 0.6;

export interface BlockFrame {
  bbox: BBox;
  depthRange: [number, number];
  /** world size (x, y, z) at the current exaggeration */
  size: [number, number, number];
}

export function makeFrame(
  bbox: BBox,
  depthRange: [number, number],
  exaggeration: number,
): BlockFrame {
  const [w, s, e, n] = bbox;
  const lonSpan = Math.max(e - w, 1e-6);
  const latSpan = Math.max(n - s, 1e-6);

  // Preserve the horizontal aspect ratio, corrected for the latitude
  // convergence of meridians, so the block is not visibly stretched.
  const midLat = (s + n) / 2;
  const lonKm = lonSpan * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const latKm = latSpan * 110.57;
  const maxKm = Math.max(lonKm, latKm, 1e-6);

  const sx = (lonKm / maxKm) * BLOCK_WIDTH;
  const sz = (latKm / maxKm) * BLOCK_WIDTH;
  const sy = BLOCK_HEIGHT * exaggeration;

  return { bbox, depthRange, size: [sx, sy, sz] };
}

/** Normalized [0,1] block coordinates for a geographic point at some depth. */
export function toBlockSpace(
  lon: number,
  lat: number,
  depth: number,
  bbox: BBox,
  depthRange: [number, number],
): [number, number, number] {
  const [w, s, e, n] = bbox;
  const [top, bottom] = depthRange;
  const x = (lon - w) / Math.max(e - w, 1e-9);
  const z = (lat - s) / Math.max(n - s, 1e-9);
  const y = 1 - (depth - top) / Math.max(bottom - top, 1e-9);
  return [x, y, z];
}

/** Normalized coordinates -> world position inside the block mesh. */
export function toWorld(
  norm: [number, number, number],
  frame: BlockFrame,
): [number, number, number] {
  const [sx, sy, sz] = frame.size;
  return [(norm[0] - 0.5) * sx, (norm[1] - 0.5) * sy, (norm[2] - 0.5) * sz];
}

/**
 * Depth of a texture layer, given the header's depth table.
 *
 * Layers are NOT evenly spaced: the model resolves the upper ocean far more
 * finely than the abyss. Geometry therefore uses normalized LAYER INDEX, and
 * the depth axis is labelled from this table -- a stretched vertical axis, as
 * ocean profile plots conventionally use. The isosurface mesh is built in the
 * same index space, so the two always align.
 */
export function layerDepth(depths: number[], t: number): number {
  if (!depths.length) return 0;
  const x = Math.min(1, Math.max(0, t)) * (depths.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  if (i >= depths.length - 1) return depths[depths.length - 1];
  return depths[i] + (depths[i + 1] - depths[i]) * f;
}

/** Inverse of layerDepth: where a given depth sits in normalized index space. */
export function depthToIndexFraction(depths: number[], depth: number): number {
  if (depths.length < 2) return 0;
  if (depth <= depths[0]) return 0;
  if (depth >= depths[depths.length - 1]) return 1;
  for (let i = 0; i < depths.length - 1; i++) {
    if (depth >= depths[i] && depth <= depths[i + 1]) {
      const f = (depth - depths[i]) / Math.max(depths[i + 1] - depths[i], 1e-9);
      return (i + f) / (depths.length - 1);
    }
  }
  return 1;
}

/**
 * THE vertical mapping for block mode: depth -> normalized height (1 = surface).
 *
 * Everything drawn inside the block must go through this. The volume is a 3D
 * texture stretched over a box, so its layers land at even fractions of the
 * block height -- the block's vertical axis IS normalized LAYER INDEX, and
 * because model levels are exponentially spaced, that is nothing like linear
 * depth. Halfway up a 0-2000 m block is ~65 m, not 1000 m.
 *
 * Positioning the seabed, floats and gliders by linear depth instead put them
 * more than half a block away from the water they belong to: a 1000 m parking
 * depth drew mid-block while that water was near the bottom, and shelf seabed
 * drew near the surface with volume rendered below it.
 *
 * Falls back to linear depth only when there is no level table yet (before the
 * first volume arrives), which is also the only time nothing else is drawn.
 */
export function depthToY(
  depths: number[],
  depth: number,
  depthRange: [number, number],
): number {
  if (depths.length >= 2) return 1 - depthToIndexFraction(depths, depth);
  const [top, bottom] = depthRange;
  return 1 - (depth - top) / Math.max(bottom - top, 1e-9);
}

/** Block-space position of a geographic point, on the block's vertical axis. */
export function toBlockSpaceAt(
  lon: number,
  lat: number,
  depth: number,
  bbox: BBox,
  depthRange: [number, number],
  depths: number[],
): [number, number, number] {
  const [x, , z] = toBlockSpace(lon, lat, depth, bbox, depthRange);
  return [x, depthToY(depths, depth, depthRange), z];
}

/** Nicely rounded depth ticks for the axis, chosen from the actual levels. */
export function depthTicks(depths: number[], count = 6): number[] {
  if (!depths.length) return [];
  const max = depths[depths.length - 1];
  const candidates = [0, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000];
  const inRange = candidates.filter((d) => d <= max);
  if (inRange.length <= count) return inRange;
  const stride = Math.ceil(inRange.length / count);
  return inRange.filter((_, i) => i % stride === 0 || i === inRange.length - 1);
}
