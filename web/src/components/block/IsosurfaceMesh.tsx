"use client";

// Server-extracted isosurface, loaded as binary glTF.
//
// Marching cubes runs on the server (skimage) rather than in the browser:
// THREE.MarchingCubes targets metaballs and implicit surfaces, not arbitrary
// scalar fields, and marching a real volume in single-threaded JS is not
// viable at these sizes.
//
// The mesh arrives in block-local normalized space -- x = lon, y = 1 - depth
// (Y-up), z = lat, all in [0,1] -- exactly matching core/geometry.py. So the
// only transform needed here is scale-and-centre, and the surface lines up
// with the volume by construction rather than by tuning.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { api } from "@/lib/api/client";
import type { BBox } from "@/lib/api/types";

interface Props {
  variable: string;
  bbox: BBox;
  depthRange: [number, number];
  level: number;
  time?: string;
  size: [number, number, number];
  color: string;
  /**
   * LOD of the volume this surface is drawn inside. Both are placed by
   * normalized level index, so a mismatched depth decimation slides the
   * surface off the feature it is supposed to trace.
   */
  res?: "coarse" | "full";
}

export default function IsosurfaceMesh({
  variable,
  bbox,
  depthRange,
  level,
  time,
  size,
  color,
  res,
}: Props) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<THREE.BufferGeometry | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    const url = api.isosurfaceUrl({ variable, bbox, depthRange, level, time, res });

    (async () => {
      try {
        const response = await fetch(url, { signal: ac.signal });
        if (!response.ok) {
          // 422 means the requested level lies outside this selection's range,
          // which is a normal thing for a user to ask for -- not a failure.
          const body = await response.json().catch(() => ({}));
          if (!cancelled) setError(body?.detail ?? `isosurface ${response.status}`);
          return;
        }
        const buf = await response.arrayBuffer();
        const gltf = await new GLTFLoader().parseAsync(buf, "");
        if (cancelled) return;

        let found: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((o) => {
          if (!found && (o as THREE.Mesh).isMesh) {
            found = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
          }
        });
        if (!found) {
          setError("isosurface contained no mesh");
          return;
        }
        current.current?.dispose();
        current.current = found;
        setError(null);
        setGeometry(found);
      } catch (e) {
        if ((e as Error).name !== "AbortError" && !cancelled) {
          setError((e as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [variable, bbox, depthRange, level, time, res]);

  // Dispose on unmount: this geometry can be a few hundred thousand vertices.
  useEffect(
    () => () => {
      current.current?.dispose();
      current.current = null;
    },
    [],
  );

  if (error || !geometry) return null;

  return (
    <mesh
      geometry={geometry}
      // normalized [0,1] -> centred world block
      scale={size}
      position={[-size[0] / 2, -size[1] / 2, -size[2] / 2]}
    >
      <meshStandardMaterial
        color={color}
        transparent
        opacity={0.55}
        roughness={0.35}
        metalness={0.1}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}
