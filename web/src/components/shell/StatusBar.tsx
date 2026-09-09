"use client";

// Bottom edge: coordinates on the left, attribution in the middle, provenance
// and model chips on the right -- Zoom Earth's arrangement, and a sensible one
// because none of it competes with the map for attention.
//
// The SYNTHETIC chip is not decoration. It is driven by the `synthetic` flag
// that flows from the catalog YAML through /api/health, so provenance is
// enforced by the data rather than by remembering to write it down.

import { Chip } from "@/components/ui";
import { formatLatLon, usePointer } from "@/state/usePointer";
import { currentTime, useSessionStore } from "@/state/useSessionStore";

export default function StatusBar() {
  const health = useSessionStore((s) => s.health);
  const time = useSessionStore(currentTime);
  const phase = useSessionStore((s) => s.phase);
  const { lat, lon, visible } = usePointer();

  const synthetic = health?.synthetic ?? true;
  const standards = [
    "CF-1.8",
    health?.standards?.wms ? "WMS" : null,
    health?.standards?.opendap ? "OPeNDAP" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {/* coordinates, under the legend */}
      <div className="pointer-events-none absolute bottom-1.5 left-3 z-20">
        <span className="ze-overlay-text font-mono" data-testid="coords">
          {visible && phase !== "block" ? formatLatLon(lat, lon) : ""}
        </span>
      </div>

      {/* attribution */}
      <div className="pointer-events-none absolute bottom-1.5 left-1/2 z-20 -translate-x-1/2">
        <span className="ze-overlay-text">
          &copy; oceanUps &middot; OpenStreetMap &middot; SYNTHETIC{" "}
          {time ? time.slice(0, 10) : ""}
        </span>
      </div>

      {/* provenance and standards */}
      <div className="pointer-events-none absolute bottom-7 right-3 z-20 flex items-center gap-2">
        {synthetic && (
          <Chip
            name="SYNTHETIC"
            tone="warn"
            title={health?.source ?? "synthetically generated fields"}
          />
        )}
        <Chip name="STANDARDS" detail={standards} title="Served CF / OGC surfaces" />
      </div>
    </>
  );
}
