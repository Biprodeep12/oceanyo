"use client";

// Module-level cache for volume payloads and GPU textures.
//
// Deliberately NOT React state. React must never hold an ArrayBuffer or a
// THREE.Data3DTexture: a re-render that drops the last reference without
// calling dispose() leaks GPU memory, and a few region selections later the
// demo laptop falls over. Lifetime here is manual and tied to the block.

import * as THREE from "three";
import type { VolumeHeader } from "@/lib/api/types";

export interface VolumeEntry {
  header: VolumeHeader;
  data: Uint8Array;
  texture: THREE.Data3DTexture;
  bytes: number;
}

const MAX_BYTES = 150 * 1024 * 1024; // hard cap, per the loading strategy
const cache = new Map<string, VolumeEntry>();

let worker: Worker | null = null;
const pending = new Map<
  string,
  { resolve: (e: VolumeEntry) => void; reject: (e: Error) => void; key: string }
>();
let seq = 0;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../../workers/volumeDecoder.worker.ts", import.meta.url));
  worker.onmessage = (ev: MessageEvent) => {
    const { type, requestId } = ev.data;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);

    if (type === "done") {
      const header = ev.data.header as VolumeHeader;
      const data = new Uint8Array(ev.data.body as ArrayBuffer);
      const built = buildEntry(header, data);
      cache.set(entry.key, built);
      evictIfNeeded(entry.key);
      entry.resolve(built);
    } else if (type === "aborted") {
      entry.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    } else {
      entry.reject(new Error(ev.data.message ?? "volume decode failed"));
    }
  };
  return worker;
}

function buildEntry(header: VolumeHeader, data: Uint8Array): VolumeEntry {
  const [nz, ny, nx] = header.dims; // depth, lat, lon -- held in this order end to end
  // Three expects (width, height, depth) = (lon, lat, depth).
  const texture = new THREE.Data3DTexture(data, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { header, data, texture, bytes: data.byteLength };
}

function evictIfNeeded(keepKey: string) {
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  if (total <= MAX_BYTES) return;
  for (const [key, entry] of cache) {
    if (key === keepKey) continue;
    entry.texture.dispose();
    cache.delete(key);
    total -= entry.bytes;
    if (total <= MAX_BYTES) break;
  }
}

export function volumeKey(opts: {
  variable: string;
  bbox: number[];
  depthRange: number[];
  time?: string;
  res: string;
}): string {
  return [
    opts.variable,
    opts.bbox.map((v) => v.toFixed(3)).join(","),
    opts.depthRange.join(","),
    opts.time ?? "latest",
    opts.res,
  ].join("|");
}

export function getCached(key: string): VolumeEntry | undefined {
  return cache.get(key);
}

/** Fetch and decode off the main thread. Resolves with a ready 3D texture. */
export function loadVolume(key: string, url: string): Promise<VolumeEntry> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const requestId = `v${++seq}`;
  return new Promise<VolumeEntry>((resolve, reject) => {
    pending.set(requestId, { resolve, reject, key });
    getWorker().postMessage({ type: "fetch", requestId, url });
  });
}

export function abortAll() {
  const w = worker;
  if (!w) return;
  for (const requestId of pending.keys()) {
    w.postMessage({ type: "abort", requestId });
  }
}

/** Free every GPU texture. Called on block exit. */
export function disposeAll() {
  abortAll();
  for (const entry of cache.values()) entry.texture.dispose();
  cache.clear();
}

export function cacheStats() {
  let bytes = 0;
  for (const e of cache.values()) bytes += e.bytes;
  return { entries: cache.size, bytes };
}

/** Decode one raw sample back to physical units (for readouts and tooltips). */
export function decodeValue(header: VolumeHeader, raw: number): number | null {
  if (raw === header.fillRaw) return null;
  return raw * header.scale + header.offset;
}
