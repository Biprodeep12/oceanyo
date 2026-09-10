"use client";

import { Suspense, useEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

import { disposeAll } from "@/lib/loading/volumeStore";
import { token } from "@/lib/theme";
import { useSessionStore } from "@/state/useSessionStore";
import BlockScene from "./BlockScene";

export default function BlockCanvas({ visible }: { visible: boolean }) {
  const phase = useSessionStore((s) => s.phase);
  const theme = useSessionStore((s) => s.theme);
  // Recomputed on theme change; `theme` is the dependency even though it is
  // not read, because the VALUE lives in CSS and only the theme moves it.
  const sceneBg = useMemo(() => token("--ze-scene-bg", "#06121c"), [theme]);

  // Free every GPU texture when the block is left. Three lines, and it is what
  // stops the tenth region selection from crashing the demo laptop.
  useEffect(() => {
    if (phase === "map") disposeAll();
  }, [phase]);

  useEffect(() => () => disposeAll(), []);

  return (
    <div
      className={`ze-canvas-host absolute inset-0 transition-opacity duration-500${visible ? "" : " ze-inert"}`}
      style={{ opacity: visible ? 1 : 0 }}
    >
      <Canvas
        camera={{ position: [2.4, 1.9, 2.8], fov: 45, near: 0.01, far: 100 }}
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
        <color attach="background" args={[sceneBg]} />
        <fog attach="fog" args={[sceneBg, 6, 16]} />
        <Suspense fallback={null}>
          <BlockScene />
        </Suspense>
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
      </Canvas>
    </div>
  );
}
