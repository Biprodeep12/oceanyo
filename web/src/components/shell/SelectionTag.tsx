"use client";

// A label pinned to the selected instrument.
//
// The ring on the map says WHICH dot the open profile belongs to; this says
// WHAT it is without making anyone read it off the panel and match it back.
//
// Deliberately a DOM element rather than a MapLibre `symbol` layer: symbol
// layers need `text-field`, which needs a glyph source, which means either a
// remote glyph server -- this project has none, on purpose, so nothing can
// stall during a demo -- or bundling a PBF font stack for one short string.

import { useEffect, useState } from "react";
import type { Map as MLMap } from "maplibre-gl";

import { useSessionStore } from "@/state/useSessionStore";

export default function SelectionTag() {
  const profile = useSessionStore((s) => s.selectedProfile);
  const phase = useSessionStore((s) => s.phase);
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // The map is the only thing that can turn a lon/lat into a pixel, and it
    // moves: the tag has to be recomputed on every frame of a pan or zoom, not
    // just when the selection changes.
    const map = (window as unknown as { __map?: MLMap }).__map;
    if (!profile || !map || phase !== "map") {
      setPt(null);
      return;
    }
    const update = () => {
      const p = map.project([profile.lon, profile.lat]);
      setPt({ x: p.x, y: p.y });
    };
    update();
    map.on("move", update);
    map.on("zoom", update);
    map.on("resize", update);
    return () => {
      map.off("move", update);
      map.off("zoom", update);
      map.off("resize", update);
    };
  }, [profile, phase]);

  if (!profile || !pt) return null;

  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{ left: pt.x, top: pt.y, transform: "translate(-50%, calc(-100% - 16px))" }}
    >
      <span className="ze-chip">
        <span className="font-semibold uppercase tracking-wider text-[color:var(--ze-accent)]">
          {profile.platform}
        </span>
        <span className="font-mono text-[color:var(--ze-text)]">{profile.id}</span>
        <span className="text-[color:var(--ze-text-faint)]">{profile.time.slice(0, 10)}</span>
      </span>
    </div>
  );
}
