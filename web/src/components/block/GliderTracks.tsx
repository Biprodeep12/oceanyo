"use client";

// Gliders: distinct geometry and their actual flight path through the water.
//
// A glider is not a float. It flies a sawtooth, so drawing it as another
// drifting capsule loses the one thing that distinguishes it. Here each
// deployment gets a torpedo-with-wings body and a track that dives and climbs
// between successive profiles -- which is exactly what the EGO format encodes,
// one descent and one ascent per pair.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { api } from "@/lib/api/client";
import type { BBox, ObservationFeature } from "@/lib/api/types";
import { makeFrame, toBlockSpaceAt, toWorld } from "@/lib/geo/blockSpace";

/** Torpedo hull, nose cone and swept wings, merged into one geometry. */
function gliderGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const hull = new THREE.CapsuleGeometry(0.012, 0.055, 4, 10);
  hull.rotateZ(Math.PI / 2);
  parts.push(hull);

  const nose = new THREE.ConeGeometry(0.012, 0.028, 10);
  nose.rotateZ(-Math.PI / 2);
  nose.translate(0.048, 0, 0);
  parts.push(nose);

  // Swept wings: thin plates angled back from the hull.
  for (const side of [1, -1]) {
    const wing = new THREE.BoxGeometry(0.03, 0.0022, 0.032);
    wing.translate(-0.012, 0, side * 0.023);
    wing.rotateY(side * -0.32);
    parts.push(wing);
  }

  // Tail fin, so orientation reads at a glance.
  const fin = new THREE.BoxGeometry(0.022, 0.024, 0.002);
  fin.translate(-0.036, 0.014, 0);
  parts.push(fin);

  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged ?? hull;
}

interface Props {
  features: ObservationFeature[];
  bbox: BBox;
  depthRange: [number, number];
  exaggeration: number;
  /** Level table from the volume header -- the vertical axis of the block. */
  depths: number[];
}

interface Track {
  deployment: string;
  points: THREE.Vector3[];
  head: THREE.Vector3;
  heading: number;
}

export default function GliderTracks({
  features,
  bbox,
  depthRange,
  exaggeration,
  depths,
}: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const geometry = useMemo(() => gliderGeometry(), []);
  const frame = useMemo(
    () => makeFrame(bbox, depthRange, exaggeration),
    [bbox, depthRange, exaggeration],
  );

  // One deployment can contribute many profiles; the trajectory is the same
  // for all of them, so fetch it once per deployment.
  const deployments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of features) {
      const id = f.properties.id;
      const code = id.split(":")[0];
      if (!seen.has(code)) seen.set(code, id);
    }
    return [...seen.entries()];
  }, [features]);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    (async () => {
      const out: Track[] = [];
      for (const [code, sampleId] of deployments) {
        try {
          const profile = await api.profile("glider", sampleId, ac.signal);
          const traj = profile.trajectory ?? [];
          if (traj.length < 2) continue;

          const maxDepth = profile.depth.length
            ? profile.depth[profile.depth.length - 1]
            : 1000;

          // Successive EGO profiles alternate descent and ascent, so the flight
          // path between them runs surface -> depth -> surface. Alternating the
          // depth per point reconstructs that sawtooth.
          const pts = traj.map((t, i) => {
            const d = i % 2 === 0 ? depthRange[0] + 5 : Math.min(maxDepth, depthRange[1]);
            const norm = toBlockSpaceAt(t.lon, t.lat, d, bbox, depthRange, depths);
            const [x, y, z] = toWorld(norm, frame);
            return new THREE.Vector3(x, y, z);
          });

          const head = pts[pts.length - 1];
          const prev = pts[pts.length - 2] ?? head;
          const heading = Math.atan2(head.z - prev.z, head.x - prev.x);
          out.push({ deployment: code, points: pts, head, heading });
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
        }
      }
      if (!cancelled) setTracks(out);
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [deployments, bbox, depthRange, frame, depths]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  // MVP item 12 had a mesh, a sawtooth reconstruction and no data in range for
  // the whole of its existence, so nothing ever asserted that it drew. Expose
  // what was actually built, the same way the floats expose `__floatPoints`.
  useEffect(() => {
    const w = window as unknown as { __gliderTracks?: () => unknown };
    w.__gliderTracks = () =>
      tracks.map((t) => ({ deployment: t.deployment, points: t.points.length }));
    return () => {
      delete w.__gliderTracks;
    };
  }, [tracks]);

  // Built as real THREE.Line objects rather than an intrinsic <line>: in JSX
  // that name resolves to the SVG element, not the three one.
  const lines = useMemo(
    () =>
      tracks.map((t) => {
        const geo = new THREE.BufferGeometry().setFromPoints(t.points);
        const mat = new THREE.LineBasicMaterial({
          color: new THREE.Color("#7ce4c8"),
          transparent: true,
          opacity: 0.75,
        });
        return new THREE.Line(geo, mat);
      }),
    [tracks],
  );

  useEffect(
    () => () =>
      lines.forEach((l) => {
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }),
    [lines],
  );

  if (!tracks.length) return null;

  return (
    <group>
      {tracks.map((t, i) => (
        <group key={t.deployment}>
          <primitive object={lines[i]} />
          <mesh geometry={geometry} position={t.head} rotation={[0, -t.heading, 0]}>
            <meshStandardMaterial color="#ffd479" roughness={0.35} metalness={0.45} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
