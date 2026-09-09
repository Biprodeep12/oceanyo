"use client";

// Builds a 256x1 RGBA lookup texture from the SAME colormaps.json the backend
// uses to render PNG tiles. One definition means a map tile and the volume
// beneath it are never coloured differently -- a mismatch there reads as a data
// bug to anyone looking at the screen.

import * as THREE from "three";
import defs from "./colormaps.json";

type Stop = [number, number, number, number];
interface ColormapSpec {
  label: string;
  description?: string;
  diverging?: boolean;
  stops: Stop[];
}

// JSON import widens the stop tuples to number[], so assert through unknown.
const COLORMAPS = (defs as unknown as { colormaps: Record<string, ColormapSpec> })
  .colormaps;

export const colormapNames = Object.keys(COLORMAPS);

export function colormapSpec(name: string): ColormapSpec {
  return COLORMAPS[name] ?? COLORMAPS.gray;
}

/** Interpolated RGB at t in 0..1. */
export function sampleColormap(name: string, t: number): [number, number, number] {
  const stops = colormapSpec(name).stops;
  const x = Math.min(1, Math.max(0, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, r0, g0, b0] = stops[i];
    const [p1, r1, g1, b1] = stops[i + 1];
    if (x >= p0 && x <= p1) {
      const f = p1 - p0 < 1e-9 ? 0 : (x - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

export function cssColor(name: string, t: number): string {
  const [r, g, b] = sampleColormap(name, t);
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

const textureCache = new Map<string, THREE.DataTexture>();

/** 256x1 RGBA lookup texture, cached per colormap name. */
export function colormapTexture(name: string): THREE.DataTexture {
  const hit = textureCache.get(name);
  if (hit) return hit;

  const size = 256;
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = sampleColormap(name, i / (size - 1));
    data[i * 4 + 0] = Math.round(r);
    data[i * 4 + 1] = Math.round(g);
    data[i * 4 + 2] = Math.round(b);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  textureCache.set(name, tex);
  return tex;
}

/** CSS gradient string for the colorbar UI. */
export function cssGradient(name: string, steps = 24): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    parts.push(`${cssColor(name, t)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
