"use client";

import { Suspense, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

import { disposeAll } from "@/lib/loading/volumeStore";
import { useSessionStore } from "@/state/useSessionStore";
import BlockScene from "./BlockScene";

export default function BlockCanvas({ visible }: { visible: boolean }) {
  const phase = useSessionStore((s) => s.phase);

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
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        dpr={[1, 2]}
      >
        <color attach="background" args={["#06121c"]} />
        <fog attach="fog" args={["#06121c", 6, 16]} />
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
