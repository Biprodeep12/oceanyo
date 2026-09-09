"use client";

// Two-point vertical cross-section, hung inside the block as a curtain.
//
// A section is how a transect is actually read: not "what does this water mass
// look like" but "what happens between here and there". Drawing it inside the
// block rather than in a side panel keeps it anchored to the geography -- you
// can see which eddy the curtain cuts through.
//
// The curtain is built as a strip of quads, one row per MODEL LEVEL, each
// placed with the same depthToY mapping the volume uses. That is why it lands
// exactly inside the volume instead of needing to be nudged: both are
// positioned by level index, and the rows of the section image ARE those
// levels.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

import { api } from "@/lib/api/client";
import type { BBox, SectionResponse } from "@/lib/api/types";
import { depthToY, makeFrame, toBlockSpace, toWorld } from "@/lib/geo/blockSpace";
import { useDisplaySettings } from "@/state/useDisplaySettings";
import { useSessionStore } from "@/state/useSessionStore";

interface Props {
  bbox: BBox;
  depthRange: [number, number];
  exaggeration: number;
  variable: string;
  time?: string;
  /** Level table from the volume header -- the vertical axis of the block. */
  depths: number[];
  size: [number, number, number];
}

/** Where a world-space point on the surface plane sits geographically. */
function worldToLonLat(
  point: THREE.Vector3,
  bbox: BBox,
  size: [number, number, number],
): [number, number] {
  const [w, s, e, n] = bbox;
  const fx = THREE.MathUtils.clamp(point.x / size[0] + 0.5, 0, 1);
  const fz = THREE.MathUtils.clamp(point.z / size[2] + 0.5, 0, 1);
  return [w + fx * (e - w), s + fz * (n - s)];
}

export default function SectionCurtain({
  bbox,
  depthRange,
  exaggeration,
  variable,
  time,
  depths,
  size,
}: Props) {
  const points = useSessionStore((s) => s.sectionPoints);
  const addSectionPoint = useSessionStore((s) => s.addSectionPoint);
  const display = useDisplaySettings();
  const [section, setSection] = useState<SectionResponse | null>(null);
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [error, setError] = useState<string | null>(null);

  const frame = useMemo(
    () => makeFrame(bbox, depthRange, exaggeration),
    [bbox, depthRange, exaggeration],
  );

  const complete = points.length >= 2;
  const key = complete
    ? `${points[0].join(",")}|${points[1].join(",")}|${variable}|${time}|${depthRange.join(",")}`
    : "";

  // --- level table and readout ---
  useEffect(() => {
    if (!complete) {
      setSection(null);
      setError(null);
      return;
    }
    const ac = new AbortController();
    api
      .section(
        {
          variable,
          p0: points[0],
          p1: points[1],
          depthRange,
          time,
          // Coarse on purpose: this request supplies the level table and the
          // readout, not the pixels. The image is fetched separately, wider.
          samples: 48,
        },
        ac.signal,
      )
      .then((r) => {
        setSection(r);
        setError(null);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, complete]);

  // --- the image itself ---
  useEffect(() => {
    if (!complete) {
      setTexture(null);
      return;
    }
    let cancelled = false;
    const url = api.sectionPngUrl({
      variable,
      p0: points[0],
      p1: points[1],
      depthRange,
      time,
      samples: 256,
      display: { range: display.range, log: display.log, colormap: display.colormap },
    });
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (cancelled) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        setTexture((old) => {
          old?.dispose();
          return tex;
        });
      },
      undefined,
      () => {
        if (!cancelled) setError("section image failed to load");
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, complete, display.range, display.log, display.colormap]);

  useEffect(() => () => texture?.dispose(), [texture]);

  const geometry = useMemo(() => {
    if (!section || section.depths.length < 2) return null;
    const a = section.p0;
    const b = section.p1;
    const levels = section.depths;
    const n = levels.length;

    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);

    const horiz = (lon: number, lat: number) => {
      const [x, , z] = toBlockSpace(lon, lat, 0, bbox, depthRange);
      return [x, z] as const;
    };
    const [ax, az] = horiz(a[0], a[1]);
    const [bx, bz] = horiz(b[0], b[1]);

    for (let j = 0; j < n; j++) {
      const yNorm = depthToY(depths, levels[j], depthRange);
      const [wax, way, waz] = toWorld([ax, yNorm, az], frame);
      const [wbx, , wbz] = toWorld([bx, yNorm, bz], frame);

      pos.set([wax, way, waz], j * 6);
      pos.set([wbx, way, wbz], j * 6 + 3);

      // Texel CENTRES, not edges: the image has n rows while the strip has
      // n-1 quads, and sampling at the edges shifts the curtain half a level.
      const v = 1 - (j + 0.5) / n;
      uv.set([0, v], j * 4);
      uv.set([1, v], j * 4 + 2);
    }

    const index: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      const t = j * 2;
      index.push(t, t + 1, t + 3, t, t + 3, t + 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return geo;
  }, [section, depths, bbox, depthRange, frame]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  // --- picking on the sea surface ---
  //
  // OrbitControls also ends a camera drag with a click, so a plain onClick
  // would drop a point every time the block is rotated. Only a pointer that
  // barely moved counts as a pick.
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const surfaceY = size[1] / 2;

  const onPointerDown = (ev: ThreeEvent<PointerEvent>) => {
    downAt.current = { x: ev.clientX, y: ev.clientY };
  };
  const onPointerUp = (ev: ThreeEvent<PointerEvent>) => {
    const start = downAt.current;
    downAt.current = null;
    if (!start) return;
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 5) return;
    ev.stopPropagation();
    const [lon, lat] = worldToLonLat(ev.point, bbox, size);
    addSectionPoint(lon, lat);
  };

  const markers = points.map((p, i) => {
    const [x, , z] = toBlockSpace(p[0], p[1], 0, bbox, depthRange);
    const [wx, , wz] = toWorld([x, 1, z], frame);
    return {
      key: `${i}-${p.join(",")}`,
      position: [wx, surfaceY, wz] as [number, number, number],
    };
  });

  const surfaceLine = useMemo(() => {
    if (points.length < 2) return null;
    const pts = points.map((p) => {
      const [x, , z] = toBlockSpace(p[0], p[1], 0, bbox, depthRange);
      const [wx, , wz] = toWorld([x, 1, z], frame);
      return new THREE.Vector3(wx, surfaceY, wz);
    });
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: "#ffd479",
      transparent: true,
      opacity: 0.9,
    });
    return new THREE.Line(geo, mat);
  }, [points, bbox, depthRange, frame, surfaceY]);

  useEffect(
    () => () => {
      if (!surfaceLine) return;
      surfaceLine.geometry.dispose();
      (surfaceLine.material as THREE.Material).dispose();
    },
    [surfaceLine],
  );

  return (
    <group>
      {/* Pick target, mounted only while a section is being placed, so it
          never sits in front of the instrument markers. */}
      {!complete && (
        <mesh
          position={[0, surfaceY, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerOver={() => (document.body.style.cursor = "crosshair")}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          <planeGeometry args={[size[0], size[2]]} />
          <meshBasicMaterial
            color="#ffd479"
            transparent
            opacity={0.06}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {markers.map((m) => (
        <mesh key={m.key} position={m.position}>
          <sphereGeometry args={[0.022, 12, 12]} />
          <meshBasicMaterial color="#ffd479" />
        </mesh>
      ))}

      {surfaceLine && <primitive object={surfaceLine} />}

      {geometry && texture && !error && (
        <mesh geometry={geometry}>
          <meshBasicMaterial
            map={texture}
            transparent
            side={THREE.DoubleSide}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}
