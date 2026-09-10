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
  /** z-slabs already pushed to the GPU; equals dims[0] once complete. */
  uploadedZ: number;
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

// Below this, one upload is cheaper than the bookkeeping to split it.
const STREAM_MIN_BYTES = 512 * 1024;

function buildEntry(header: VolumeHeader, data: Uint8Array): VolumeEntry {
  const [nz, ny, nx] = header.dims; // depth, lat, lon -- held in this order end to end

  // Spec 5.1 item 5: allocate empty, then push one slab per frame.
  //
  // A single texImage3D on a full-resolution volume hands the driver 4 MB in
  // one call and blocks until it lands -- during the extrude, which is the one
  // moment in this app where a dropped frame is the whole point of the
  // feature. Passing `null` as the data makes three allocate the storage
  // WITHOUT transferring anything, and `pumpUploads` fills it afterwards.
  //
  // The half-filled state is not a glitch to hide: raw 0 is reserved for fill
  // (see the wire format), so the shader already discards un-uploaded voxels as
  // land. The volume grows downward from the surface, which reads as loading
  // rather than as corruption.
  const stream = data.byteLength >= STREAM_MIN_BYTES;
  const texture = new THREE.Data3DTexture(
    (stream ? null : data) as unknown as Uint8Array,
    nx,
    ny,
    nz,
  );
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  const entry: VolumeEntry = {
    header,
    data,
    texture,
    bytes: data.byteLength,
    uploadedZ: stream ? 0 : nz,
  };
  if (stream) streaming.add(entry);
  return entry;
}

/** Entries with slabs still to push. Pumped once per frame by the scene. */
const streaming = new Set<VolumeEntry>();

/**
 * Push a few z-slabs of every incomplete volume. Call once per rendered frame.
 *
 * three has no texSubImage3D of its own, so this reaches for the raw context
 * and the texture object three created. The previous 3D binding is restored
 * afterwards: three tracks bound textures itself, and leaving a foreign one
 * bound makes the NEXT draw sample whatever we left there.
 */
export function pumpUploads(renderer: THREE.WebGLRenderer): void {
  if (streaming.size === 0) return;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (typeof gl.texSubImage3D !== "function") {
    // WebGL1 tier; nothing to stream into.
    for (const e of streaming) e.uploadedZ = e.header.dims[0];
    streaming.clear();
    return;
  }

  for (const entry of [...streaming]) {
    const [nz, ny, nx] = entry.header.dims;
    const props = renderer.properties.get(entry.texture) as {
      __webglTexture?: WebGLTexture;
    };
    // three allocates on first use. Until it has, there is nothing to fill.
    if (!props?.__webglTexture) continue;

    // Eight frames to fill, so a 60 fps client sees it complete in ~130 ms and
    // a software renderer still makes progress every frame.
    const perFrame = Math.max(1, Math.ceil(nz / 8));
    const z0 = entry.uploadedZ;
    const count = Math.min(perFrame, nz - z0);
    if (count <= 0) {
      streaming.delete(entry);
      continue;
    }

    const slab = nx * ny;
    const view = entry.data.subarray(z0 * slab, (z0 + count) * slab);
    const prev = gl.getParameter(gl.TEXTURE_BINDING_3D) as WebGLTexture | null;
    try {
      gl.bindTexture(gl.TEXTURE_3D, props.__webglTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(
        gl.TEXTURE_3D, 0, 0, 0, z0, nx, ny, count,
        gl.RED, gl.UNSIGNED_BYTE, view,
      );
      entry.uploadedZ = z0 + count;
    } catch {
      // Any driver that refuses gets the whole thing in one go rather than a
      // permanently half-drawn volume.
      entry.texture.image.data = entry.data;
      entry.texture.needsUpdate = true;
      entry.uploadedZ = nz;
    } finally {
      gl.bindTexture(gl.TEXTURE_3D, prev);
    }
    if (entry.uploadedZ >= nz) streaming.delete(entry);
  }
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
  streaming.clear();
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
