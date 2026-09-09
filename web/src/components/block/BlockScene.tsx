"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { api } from "@/lib/api/client";
import type { BathymetryResponse, BBox, VolumeHeader } from "@/lib/api/types";
import { colormapTexture } from "@/lib/color/colormaps";
import {
  depthToIndexFraction,
  depthToY,
  layerDepth,
  makeFrame,
  toBlockSpaceAt,
  toWorld,
} from "@/lib/geo/blockSpace";
import { getCached, loadVolume, volumeKey } from "@/lib/loading/volumeStore";
import { probeGpu } from "@/three/caps";
import { volumeFragmentWithSteps, volumeVertexShader } from "@/three/shaders/volume";
import { currentTime, currentVariable, useSessionStore } from "@/state/useSessionStore";
import { useDisplaySettings } from "@/state/useDisplaySettings";
import CurrentParticles from "./CurrentParticles";
import GliderTracks from "./GliderTracks";
import IsosurfaceMesh from "./IsosurfaceMesh";
import SectionCurtain from "./SectionCurtain";

// ---------------------------------------------------------------- seabed

function SeabedMesh({
  bathy,
  bbox,
  depthRange,
  exaggeration,
  depths,
}: {
  bathy: BathymetryResponse;
  bbox: BBox;
  depthRange: [number, number];
  exaggeration: number;
  depths: number[];
}) {
  const geometry = useMemo(() => {
    const [ny, nx] = bathy.shape;
    const frame = makeFrame(bbox, depthRange, exaggeration);
    const geo = new THREE.PlaneGeometry(frame.size[0], frame.size[2], nx - 1, ny - 1);
    const pos = geo.attributes.position as THREE.BufferAttribute;

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        const elev = bathy.elevation[j][i];
        // elevation is positive up; depth is positive down.
        const d = Math.min(Math.max(-elev, depthRange[0]), depthRange[1]);
        // depthToY, not linear depth: the volume above this seabed is placed
        // by level index, and mixing the two drew shelf seabed near the
        // surface with rendered water beneath it.
        const yNorm = depthToY(depths, d, depthRange);
        const [, y] = toWorld([0, yNorm, 0], frame);
        pos.setZ(idx, y); // plane is rotated below, so Z becomes height
      }
    }
    geo.computeVertexNormals();
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bathy, bbox.join(","), depthRange.join(","), exaggeration, depths]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <meshStandardMaterial
        color="#5a4a3d"
        roughness={0.95}
        metalness={0.02}
        side={THREE.DoubleSide}
        flatShading={false}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------- volume

function VolumeMesh({
  header,
  texture,
  size,
  colormap,
  opacity,
  clipY,
  moving,
  display,
  log,
}: {
  header: VolumeHeader;
  texture: THREE.Data3DTexture;
  size: [number, number, number];
  colormap: string;
  opacity: number;
  clipY: [number, number];
  moving: boolean;
  display: [number, number];
  log: boolean;
}) {
  const caps = probeGpu();
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const meshRef = useRef<THREE.Mesh>(null);

  // Adaptive ray-marching: a cheap shader while the camera moves or the
  // timeline plays, a high-quality one when idle. Recompiled, not branched.
  const steps = moving ? caps.steps.moving : caps.steps.idle;

  const material = useMemo(() => {
    const half = new THREE.Vector3(size[0] / 2, size[1] / 2, size[2] / 2);
    return new THREE.ShaderMaterial({
      vertexShader: volumeVertexShader,
      fragmentShader: volumeFragmentWithSteps(steps),
      uniforms: {
        uVolume: { value: texture },
        uColormap: { value: colormapTexture(colormap) },
        uBoxMin: { value: half.clone().negate() },
        uBoxMax: { value: half.clone() },
        uOpacity: { value: opacity },
        uThreshold: { value: 0.02 },
        uClipY: { value: new THREE.Vector2(clipY[0], clipY[1]) },
        uCamLocal: { value: new THREE.Vector3() },
        // WebGL hands the shader raw/255, so the quantization scale is
        // multiplied by 255 to invert it in one multiply-add.
        uScale255: { value: header.scale * 255 },
        uOffset: { value: header.offset },
        uDisplay: { value: new THREE.Vector2(display[0], display[1]) },
        uLog: { value: log ? 1 : 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide, // march from the back faces inward
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texture, steps, colormap, size.join(",")]);

  useEffect(() => {
    if (!materialRef.current) return;
    const u = materialRef.current.uniforms;
    u.uOpacity.value = opacity;
    u.uClipY.value.set(clipY[0], clipY[1]);
    u.uDisplay.value.set(display[0], display[1]);
    u.uLog.value = log ? 1 : 0;
    u.uScale255.value = header.scale * 255;
    u.uOffset.value = header.offset;
  }, [opacity, clipY, display, log, header]);

  useEffect(() => () => material.dispose(), [material]);

  // Camera position in object space, refreshed each frame. Constant across the
  // draw call, so this belongs on the CPU rather than in the fragment shader.
  const camLocal = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    const mesh = meshRef.current;
    if (!mesh || !materialRef.current) return;
    camLocal.copy(camera.position);
    mesh.worldToLocal(camLocal);
    materialRef.current.uniforms.uCamLocal.value.copy(camLocal);
  });

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={size} />
      <primitive object={material} ref={materialRef} attach="material" />
    </mesh>
  );
}

// ---------------------------------------------------------------- instruments

function Instruments({
  bbox,
  depthRange,
  exaggeration,
  depths,
}: {
  bbox: BBox;
  depthRange: [number, number];
  exaggeration: number;
  depths: number[];
}) {
  const observations = useSessionStore((s) => s.observations);
  const errorById = useSessionStore((s) => s.errorById);
  const setSelectedProfile = useSessionStore((s) => s.setSelectedProfile);
  const setMatchup = useSessionStore((s) => s.setMatchup);
  const setLoadingProfile = useSessionStore((s) => s.setLoadingProfile);
  const variable = useSessionStore((s) => s.variable);

  const inBox = useMemo(
    () =>
      observations.filter((f) => {
        const [lon, lat] = f.geometry.coordinates;
        return (
          f.properties.platform !== "glider" &&
          lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
        );
      }),
    [observations, bbox],
  );

  // Gliders are drawn by GliderTracks: they fly a sawtooth, so a drifting
  // capsule at a single parking depth would misrepresent them.
  const gliders = useMemo(
    () =>
      observations.filter((f) => {
        const [lon, lat] = f.geometry.coordinates;
        return (
          f.properties.platform === "glider" &&
          lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
        );
      }),
    [observations, bbox],
  );

  const frame = useMemo(
    () => makeFrame(bbox, depthRange, exaggeration),
    [bbox, depthRange, exaggeration],
  );

  const meshRef = useRef<THREE.InstancedMesh>(null);

  // One InstancedMesh: N instruments cost one draw call, not N meshes.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    inBox.forEach((f, i) => {
      const [lon, lat] = f.geometry.coordinates;
      // Floats sit at their parking depth so they read as being in the water
      // column rather than pinned to the surface.
      const d = Math.min(Math.max(1000, depthRange[0]), depthRange[1]);
      const norm = toBlockSpaceAt(lon, lat, d, bbox, depthRange, depths);
      const [x, y, z] = toWorld(norm, frame);
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Colour = model-observation error magnitude where known, grey where not.
      const err = errorById[f.properties.id];
      if (err === undefined) color.set("#8aa0b4");
      else if (err < 0.35) color.set("#3fb98a");
      else if (err < 0.8) color.set("#e8c15a");
      else color.set("#e2603f");
      mesh.setColorAt(i, color);
    });

    mesh.count = inBox.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [inBox, errorById, bbox, depthRange, frame, depths]);

  const onClick = async (ev: { instanceId?: number; stopPropagation: () => void }) => {
    ev.stopPropagation();
    const i = ev.instanceId;
    if (i === undefined || !inBox[i]) return;
    const { platform, id } = inBox[i].properties;
    setLoadingProfile(true);
    try {
      const [profile, match] = await Promise.all([
        api.profile(platform, id),
        api.matchup({ platform, id, variable }).catch(() => null),
      ]);
      setSelectedProfile(profile);
      setMatchup(match);
    } finally {
      setLoadingProfile(false);
    }
  };

  const floats = inBox.length ? (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, Math.max(inBox.length, 1)]}
      onClick={onClick}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <capsuleGeometry args={[0.018, 0.05, 4, 8]} />
      <meshStandardMaterial roughness={0.4} metalness={0.3} />
    </instancedMesh>
  ) : null;

  return (
    <group>
      {floats}
      <GliderTracks
        features={gliders}
        bbox={bbox}
        depthRange={depthRange}
        exaggeration={exaggeration}
        depths={depths}
      />
    </group>
  );
}

// ---------------------------------------------------------------- frame + axes

function BlockFrameLines({ size }: { size: [number, number, number] }) {
  const geo = useMemo(() => {
    const box = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, [size]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#4fd1c5" transparent opacity={0.5} />
    </lineSegments>
  );
}

/** Translucent plane showing the currently selected depth. */
function DepthSlicePlane({
  size,
  y,
}: {
  size: [number, number, number];
  y: number;
}) {
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[size[0], size[2]]} />
      <meshBasicMaterial
        color="#4fd1c5"
        transparent
        opacity={0.10}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------- scene

export default function BlockScene() {
  const selection = useSessionStore((s) => s.selection);
  const depthRange = useSessionStore((s) => s.depthRange);
  const exaggeration = useSessionStore((s) => s.exaggeration);
  const showVolume = useSessionStore((s) => s.showVolume);
  const showSlice = useSessionStore((s) => s.showSlice);
  const showIsosurface = useSessionStore((s) => s.showIsosurface);
  const showParticles = useSessionStore((s) => s.showParticles);
  const showSection = useSessionStore((s) => s.showSection);
  const isoLevel = useSessionStore((s) => s.isoLevel);
  const opacity = useSessionStore((s) => s.opacity);
  const depth = useSessionStore((s) => s.depth);
  const variable = useSessionStore((s) => s.variable);
  const playing = useSessionStore((s) => s.playing);
  const varMeta = useSessionStore(currentVariable);
  const display = useDisplaySettings();
  const time = useSessionStore(currentTime);
  const setPhase = useSessionStore((s) => s.setPhase);
  const phase = useSessionStore((s) => s.phase);

  const caps = probeGpu();
  const [bathy, setBathy] = useState<BathymetryResponse | null>(null);
  const [volume, setVolume] = useState<{
    header: VolumeHeader;
    texture: THREE.Data3DTexture;
  } | null>(null);
  const [moving, setMoving] = useState(false);
  const movingTimer = useRef<number | null>(null);
  const { camera } = useThree();
  const lastCam = useRef(new THREE.Vector3());

  const frame = useMemo(
    () => (selection ? makeFrame(selection, depthRange, exaggeration) : null),
    [selection, depthRange, exaggeration],
  );

  // The block vertical axis, shared by the volume, the seabed, the
  // instruments and the section curtain. Memoized for a stable identity: a
  // fresh `[]` on every render would re-run the seabed geometry build on
  // every frame while the volume is still in flight. Declared here, above
  // every early return, so the hook order never changes.
  const depths = useMemo(() => volume?.header.depths ?? [], [volume]);

  // Advance out of the transition when the water column is actually ready.
  //
  // This is deliberately NOT done inside the fetch effect: that effect doubles
  // as a prefetch while the user is still adjusting the rectangle, so by the
  // time Dive is pressed the volume is usually already cached and the effect
  // never re-runs. Keying on readiness instead means the transition completes
  // whether the data arrived early (prefetch hit) or late.
  useEffect(() => {
    if (!volume) return;
    if (phase === "extruding" || phase === "holding") setPhase("block");
  }, [volume, phase, setPhase]);

  // Stage 0: bathymetry, decimated. Renders the block frame and seabed before
  // any water-column data has arrived.
  useEffect(() => {
    if (!selection) return;
    const ac = new AbortController();
    api
      .bathymetry(selection, 96, ac.signal)
      .then(setBathy)
      .catch((e) => {
        if (e.name !== "AbortError") console.warn("bathymetry:", e.message);
      });
    return () => ac.abort();
  }, [selection]);

  // Stages 1 and 2: coarse volume first, then full resolution swapped in.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;

    const fetchAt = async (res: "coarse" | "full") => {
      const opts = { variable, bbox: selection, depthRange, time, res };
      const key = volumeKey({ ...opts, res });
      const cached = getCached(key);
      if (cached) {
        if (!cancelled) setVolume({ header: cached.header, texture: cached.texture });
        return true;
      }
      try {
        const entry = await loadVolume(key, api.volumeUrl(opts));
        if (!cancelled) setVolume({ header: entry.header, texture: entry.texture });
        return true;
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.warn("volume:", (e as Error).message);
        return false;
      }
    };

    (async () => {
      await fetchAt("coarse");
      if (cancelled) return;
      if (caps.volumeRes === "full") await fetchAt("full");
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, depthRange, variable, time]);

  // Detect camera motion to drive adaptive ray-marching.
  useFrame(() => {
    if (!camera.position.equals(lastCam.current)) {
      lastCam.current.copy(camera.position);
      if (!moving) setMoving(true);
      if (movingTimer.current) window.clearTimeout(movingTimer.current);
      movingTimer.current = window.setTimeout(() => setMoving(false), 220);
    }
  });

  if (!selection || !frame) return null;

  const sliceFraction = depths.length ? depthToIndexFraction(depths, depth) : 0;
  const sliceY = (0.5 - sliceFraction) * frame.size[1];

  return (
    <group>
      <ambientLight intensity={0.75} />
      <directionalLight position={[3, 6, 4]} intensity={1.15} />
      <directionalLight position={[-4, 2, -3]} intensity={0.35} color="#7fb6ff" />

      <BlockFrameLines size={frame.size} />

      {bathy && (
        <SeabedMesh
          bathy={bathy}
          bbox={selection}
          depthRange={depthRange}
          exaggeration={exaggeration}
          depths={depths}
        />
      )}

      {showVolume && volume && caps.tier !== "slices" && (
        <VolumeMesh
          header={volume.header}
          texture={volume.texture}
          size={frame.size}
          colormap={display.colormap}
          opacity={opacity}
          clipY={[-frame.size[1], frame.size[1]]}
          moving={moving || playing}
          display={display.range}
          log={display.log}
        />
      )}

      {showSlice && depths.length > 0 && (
        <DepthSlicePlane size={frame.size} y={sliceY} />
      )}

      {showParticles && depths.length > 0 && (
        <CurrentParticles
          bbox={selection}
          depth={depth}
          time={time}
          size={frame.size}
          planeY={sliceY}
        />
      )}

      {showIsosurface && (
        <IsosurfaceMesh
          variable={variable}
          bbox={selection}
          depthRange={depthRange}
          level={isoLevel}
          time={time}
          size={frame.size}
          color="#9ae6f5"
          // Same LOD as the volume on screen, so both land on the same levels.
          res={volume?.header.resolution ?? caps.volumeRes}
        />
      )}

      {showSection && (
        <SectionCurtain
          bbox={selection}
          depthRange={depthRange}
          exaggeration={exaggeration}
          variable={variable}
          time={time}
          depths={depths}
          size={frame.size}
        />
      )}

      <Instruments
        bbox={selection}
        depthRange={depthRange}
        exaggeration={exaggeration}
        depths={depths}
      />
    </group>
  );
}

export { layerDepth };
