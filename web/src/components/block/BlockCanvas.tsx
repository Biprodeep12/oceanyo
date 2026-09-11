"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

import { disposeAll } from "@/lib/loading/volumeStore";
import { token } from "@/lib/theme";
import { useSessionStore } from "@/state/useSessionStore";
import BlockScene from "./BlockScene";

/**
 * The scene's own sky, faded in as the block comes out.
 *
 * The block canvas used to paint an opaque background, which meant the instant
 * it appeared it covered the map -- and a dive that is supposed to be one
 * continuous movement began by hiding the thing it was moving away from. The
 * background is a DOM layer behind a transparent canvas instead, so during the
 * handoff the map is still visible underneath the block's lid, and the sky
 * closes over it as the camera tilts.
 *
 * Fog goes with it. Fog against a transparent background dims the block toward
 * a colour that is not on screen yet, and at the handoff distance it dimmed it
 * almost to nothing.
 */
function Atmosphere({
  bg,
  backdrop,
}: {
  bg: string;
  backdrop: React.RefObject<HTMLDivElement | null>;
}) {
  const { scene } = useThree();
  const fog = useMemo(() => new THREE.Fog(bg, 6, 16), [bg]);
  const last = useRef(-1);

  useEffect(() => {
    scene.background = null;
    return () => {
      scene.fog = null;
    };
  }, [scene]);

  useFrame(() => {
    const p = useSessionStore.getState().blockProgress;
    if (Math.abs(p - last.current) < 0.002) return;
    last.current = p;
    const el = backdrop.current;
    // Opaque well before the end: by two-thirds of the way out the block is
    // tilted enough that seeing a map edge past its corner reads as a seam.
    if (el) el.style.opacity = String(Math.min(1, p / 0.66));
    scene.fog = p > 0.985 ? fog : null;
  });

  return null;
}

export default function BlockCanvas({ visible }: { visible: boolean }) {
  const phase = useSessionStore((s) => s.phase);
  const theme = useSessionStore((s) => s.theme);
  // Recomputed on theme change; `theme` is the dependency even though it is
  // not read, because the VALUE lives in CSS and only the theme moves it.
  const sceneBg = useMemo(() => token("--ze-scene-bg", "#06121c"), [theme]);
  const backdrop = useRef<HTMLDivElement | null>(null);

  // Free every GPU texture when the block is left. Three lines, and it is what
  // stops the tenth region selection from crashing the demo laptop.
  useEffect(() => {
    if (phase === "map") disposeAll();
  }, [phase]);

  useEffect(() => () => disposeAll(), []);

  return (
    <div
      // 180 ms, not 500: the first frame of the block is registered with the
      // map's rectangle, so there is nothing to disguise with a long fade --
      // and a long one leaves the two images visibly double-exposed.
      className={`ze-canvas-host absolute inset-0 transition-opacity duration-[180ms]${visible ? "" : " ze-inert"}`}
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div
        ref={backdrop}
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: sceneBg, opacity: 0 }}
      />
      <Canvas
        // -Z is north in the mirrored scene, so this is the north-east view it
        // has always looked like.
        camera={{ position: [2.4, 1.9, -2.8], fov: 45, near: 0.01, far: 100 }}
        // preserveDrawingBuffer, so the block can be exported as a PNG.
        // WebGL is free to clear the backbuffer the instant a frame is
        // composited, and without this flag toDataURL returns a blank image
        // with no error whatsoever -- the classic "screenshot works in dev,
        // is transparent in the deck" bug.
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
          preserveDrawingBuffer: true,
        }}
        dpr={[1, 2]}
      >
        {/* three cannot parse var(--x), so the token is resolved here and
            re-read whenever the theme changes. */}
        <Atmosphere bg={sceneBg} backdrop={backdrop} />
        <Suspense fallback={null}>
          <BlockScene />
        </Suspense>
        {/* Mounted once the flight has landed -- which is "holding" as well as
            "block". Not `enabled={false}`: OrbitControls recomputes the camera
            from its own state on every update, so while it exists it owns the
            camera and would drag the dive back to where it thought the camera
            should be.

            "holding" matters: it is where a dive parks when the water column
            never arrives, and gating on "block" alone left that case with a
            block nobody could turn -- a failed fetch becoming a frozen app. */}
        {(phase === "block" || phase === "holding") && (
        <OrbitControls
          enablePan
          enableDamping
          dampingFactor={0.08}
          minDistance={0.9}
          // Tall viewports and 10x vertical exaggeration both push the fitted
          // camera well past the old 9-unit ceiling, which silently clamped
          // the block to a cropped view it could not be zoomed out of.
          maxDistance={24}
          makeDefault
        />
        )}
      </Canvas>
    </div>
  );
}
