"use client";

// The locator inset.
//
// Choosing a flat map over a globe buys real things -- a true Cartesian depth
// axis, honest vertical exaggeration, cheap cross-sections -- and costs one:
// the "where on Earth am I" glance a globe gives for free. This is the cheap
// recovery the spec asks for.
//
// It is drawn from the SAME coastline the map uses, which is traced from this
// project's own bathymetry rather than fetched from a basemap provider. That
// matters twice: nothing here can stall on a third-party tile server during a
// demo, and the inset cannot quietly disagree with the map beside it.

import { useMemo } from "react";

import { useIsMobile } from "@/state/useMediaQuery";
import { viewport } from "@/lib/viewport";
import { useSessionStore } from "@/state/useSessionStore";

const W = 104;
const H = 104;
const PAD = 5;

type Ring = [number, number][];

/** Pull every ring out of a FeatureCollection of Polygons/MultiPolygons. */
function ringsOf(fc: GeoJSON.FeatureCollection | null): Ring[] {
  if (!fc?.features) return [];
  const out: Ring[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      for (const r of g.coordinates) out.push(r as Ring);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) for (const r of poly) out.push(r as Ring);
    }
  }
  return out;
}

export default function LocatorInset() {
  const coastline = useSessionStore((s) => s.coastline);
  const domain = useSessionStore((s) => s.domain);
  const selection = useSessionStore((s) => s.selection);
  const phase = useSessionStore((s) => s.phase);
  const mobile = useIsMobile();

  const g = useMemo(() => {
    if (!domain) return null;
    const [w, s, e, n] = domain;
    // Fit the domain into the box, preserving aspect so the Bay of Bengal is
    // not stretched into a square.
    const sx = (W - 2 * PAD) / Math.max(e - w, 1e-6);
    const sy = (H - 2 * PAD) / Math.max(n - s, 1e-6);
    const k = Math.min(sx, sy);
    const ox = PAD + (W - 2 * PAD - (e - w) * k) / 2;
    const oy = PAD + (H - 2 * PAD - (n - s) * k) / 2;
    const x = (lon: number) => ox + (lon - w) * k;
    // y is flipped: SVG grows downward, latitude grows north.
    const y = (lat: number) => oy + (n - lat) * k;

    const paths: string[] = [];
    for (const ring of ringsOf(coastline)) {
      if (ring.length < 3) continue;
      let d = "";
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        d += `${i === 0 ? "M" : "L"}${x(lon).toFixed(1)},${y(lat).toFixed(1)}`;
      }
      paths.push(d + "Z");
    }
    return { x, y, paths };
  }, [coastline, domain]);

  // No room beside the timeline on a phone, and orientation is less of a
  // problem on a screen that shows one thing at a time.
  if (mobile || !domain || !g) return null;

  const [dw, ds, de, dn] = domain;
  const sel = selection
    ? {
        x: g.x(Math.min(selection[0], selection[2])),
        y: g.y(Math.max(selection[1], selection[3])),
        w: Math.abs(g.x(selection[2]) - g.x(selection[0])),
        h: Math.abs(g.y(selection[1]) - g.y(selection[3])),
      }
    : null;

  return (
    <button
      className="ze-panel block cursor-pointer p-0 leading-none"
      title="Model domain. Click to frame the whole region."
      aria-label="Locator: model domain"
      onClick={() => viewport.reset()}
    >
      <svg width={W} height={H} role="img" aria-label="Locator map">
        <rect x={0} y={0} width={W} height={H} rx={10} fill="var(--ze-ocean)" />
        {/* the model domain: everything this catalog can serve */}
        <rect
          x={g.x(dw)}
          y={g.y(dn)}
          width={g.x(de) - g.x(dw)}
          height={g.y(ds) - g.y(dn)}
          fill="none"
          stroke="var(--ze-grid)"
          strokeWidth={1}
        />
        {/* Land needs to read at 104px. #16232e on the #06121c ocean is a
            two-step difference in value and disappears entirely at this size,
            which makes the inset look like an empty box. */}
        {g.paths.map((d, i) => (
          <path key={i} d={d} fill="var(--ze-land)" stroke="var(--ze-land-edge)" strokeWidth={0.6} />
        ))}
        {sel && sel.w > 0 && sel.h > 0 && (
          <rect
            x={sel.x}
            y={sel.y}
            width={Math.max(sel.w, 2)}
            height={Math.max(sel.h, 2)}
            fill="rgba(79,209,197,0.22)"
            stroke="var(--ze-accent)"
            strokeWidth={1.4}
          />
        )}
        <text x={6} y={H - 5} fill="var(--ze-chart-label)" fontSize={8} fontFamily="monospace">
          {phase === "block" ? "block" : "domain"}
        </text>
      </svg>
    </button>
  );
}
