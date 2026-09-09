"use client";

// Depth-aware animated current layer.
//
// Positions are ping-ponged between two float render targets and never reach
// the CPU. The velocity field is the RG-encoded PNG from /api/currents for the
// currently selected depth, so moving the depth slider swaps the texture and
// the flow changes with it -- that is what "depth-aware" means here.

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { api } from "@/lib/api/client";
import type { BBox, CurrentsMeta } from "@/lib/api/types";
import {
  particleDrawFragmentShader,
  particleDrawVertexShader,
  particleUpdateShader,
  quadVertexShader,
} from "@/three/shaders/particles";

const TEX = 64; // 64x64 = 4096 particles
const COUNT = TEX * TEX;

interface Props {
  bbox: BBox;
  depth: number;
  time?: string;
  size: [number, number, number];
  planeY: number;
  playbackSpeed?: number;
}

function metresExtent(bbox: BBox): [number, number] {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  return [
    (e - w) * 111_320 * Math.cos((midLat * Math.PI) / 180),
    (n - s) * 110_540,
  ];
}

export default function CurrentParticles({
  bbox,
  depth,
  time,
  size,
  planeY,
  // Time compression for the advection, in simulated seconds per real second.
  // At 1x a 1 m/s current crosses ~0.1% of a basin-scale block per second and
  // nothing appears to move. Direction and relative magnitude are the model's;
  // only the playback rate is scaled, and the UI says so.
  playbackSpeed = 12000,
}: Props) {
  const { gl } = useThree();
  const [velocity, setVelocity] = useState<{
    texture: THREE.Texture;
    meta: CurrentsMeta;
  } | null>(null);

  // --- velocity texture for the current depth ---
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    (async () => {
      try {
        const meta = await api.currentsMeta({ bbox, depth, time, res: 256 }, ac.signal);
        const url = api.currentsPngUrl({ bbox, depth, time, res: 256 });
        const tex = await new Promise<THREE.Texture>((resolve, reject) => {
          new THREE.TextureLoader().load(url, resolve, undefined, reject);
        });
        if (cancelled) {
          tex.dispose();
          return;
        }
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        // The PNG is data, not colour: sampling it through sRGB decode would
        // bend every velocity toward zero.
        tex.colorSpace = THREE.NoColorSpace;
        setVelocity((prev) => {
          prev?.texture.dispose();
          return { texture: tex, meta };
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          console.warn("currents:", (e as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [bbox, depth, time]);

  useEffect(() => () => velocity?.texture.dispose(), [velocity]);

  // --- ping-pong targets seeded with random positions ---
  const { targets, seedTexture } = useMemo(() => {
    const data = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      const x = Math.random();
      const y = Math.random();
      data[i * 4 + 0] = x;
      data[i * 4 + 1] = y;
      data[i * 4 + 2] = x;
      data[i * 4 + 3] = y;
    }
    const seed = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat, THREE.FloatType);
    seed.needsUpdate = true;

    const opts: THREE.RenderTargetOptions = {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    return {
      seedTexture: seed,
      targets: [
        new THREE.WebGLRenderTarget(TEX, TEX, opts),
        new THREE.WebGLRenderTarget(TEX, TEX, opts),
      ] as [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget],
    };
  }, []);

  // --- offscreen update pass ---
  const update = useMemo(() => {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const material = new THREE.ShaderMaterial({
      vertexShader: quadVertexShader,
      fragmentShader: particleUpdateShader,
      uniforms: {
        uPositions: { value: seedTexture as THREE.Texture },
        uVelocity: { value: null },
        uURange: { value: new THREE.Vector2(-1, 1) },
        uVRange: { value: new THREE.Vector2(-1, 1) },
        uMetres: { value: new THREE.Vector2(1e6, 1e6) },
        uDt: { value: 0.016 },
        uSpeed: { value: playbackSpeed },
        uDropRate: { value: 0.004 },
        uSeed: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    return { scene, camera, material };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedTexture]);

  // --- draw geometry: two vertices per particle (tail, head) ---
  const geometry = useMemo(() => {
    const refs = new Float32Array(COUNT * 2 * 2);
    const ends = new Float32Array(COUNT * 2);
    let k = 0;
    for (let i = 0; i < COUNT; i++) {
      const u = ((i % TEX) + 0.5) / TEX;
      const v = (Math.floor(i / TEX) + 0.5) / TEX;
      refs[k * 2] = u;
      refs[k * 2 + 1] = v;
      ends[k] = 0;
      k++;
      refs[k * 2] = u;
      refs[k * 2 + 1] = v;
      ends[k] = 1;
      k++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("aRef", new THREE.BufferAttribute(refs, 2));
    geo.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));
    // position is unused (the vertex shader computes it) but three requires it
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 2 * 3), 3));
    return geo;
  }, []);

  const drawMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: particleDrawVertexShader,
        fragmentShader: particleDrawFragmentShader,
        uniforms: {
          uPositions: { value: null },
          uVelocity: { value: null },
          uURange: { value: new THREE.Vector2(-1, 1) },
          uVRange: { value: new THREE.Vector2(-1, 1) },
          uSize: { value: new THREE.Vector3(1, 1, 1) },
          uPlaneY: { value: 0 },
          uStreak: { value: 0.045 },
          uMaxSpeed: { value: 1.2 },
          uSlowColor: { value: new THREE.Color("#39c8ff") },
          uFastColor: { value: new THREE.Color("#eaffff") },
          uOpacity: { value: 1.0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      drawMaterial.dispose();
      update.material.dispose();
      targets[0].dispose();
      targets[1].dispose();
      seedTexture.dispose();
    },
    [geometry, drawMaterial, update, targets, seedTexture],
  );

  const which = useRef(0);
  const seeded = useRef(false);

  useFrame((_, delta) => {
    if (!velocity) return;

    const [uMin, uMax] = [velocity.meta.uMin, velocity.meta.uMax];
    const [vMin, vMax] = [velocity.meta.vMin, velocity.meta.vMax];
    const [mx, my] = metresExtent(bbox);

    const u = update.material.uniforms;
    u.uVelocity.value = velocity.texture;
    u.uURange.value.set(uMin, uMax);
    u.uVRange.value.set(vMin, vMax);
    u.uMetres.value.set(mx, my);
    u.uDt.value = Math.min(delta, 0.05); // clamp: a stalled tab must not teleport
    u.uSpeed.value = playbackSpeed;
    u.uSeed.value = Math.random();
    u.uPositions.value = seeded.current ? targets[which.current].texture : seedTexture;

    const dst = targets[1 - which.current];
    const prevTarget = gl.getRenderTarget();
    gl.setRenderTarget(dst);
    gl.render(update.scene, update.camera);
    gl.setRenderTarget(prevTarget);

    which.current = 1 - which.current;
    seeded.current = true;

    const d = drawMaterial.uniforms;
    d.uPositions.value = targets[which.current].texture;
    d.uVelocity.value = velocity.texture;
    d.uURange.value.set(uMin, uMax);
    d.uVRange.value.set(vMin, vMax);
    d.uSize.value.set(size[0], size[1], size[2]);
    d.uPlaneY.value = planeY;
  });

  if (!velocity) return null;

  return <lineSegments geometry={geometry} material={drawMaterial} frustumCulled={false} />;
}
