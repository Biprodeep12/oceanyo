"use client";

// One-click report: image, table, session.
//
// Three formats rather than a PDF. A PDF needs a layout engine in the bundle
// and produces something nobody can re-analyse; what a scientist actually
// wants out of a screen like this is the picture for a slide, the numbers for
// a spreadsheet, and the state for a colleague. All three are a few lines with
// no dependency.
//
// **Every export carries its provenance.** The CSV opens with commented header
// lines naming the model, the catalogue, the QC convention and the disclaimer,
// and the JSON embeds the whole /api/provenance record. A number that leaves
// this application without saying where it came from is the failure mode the
// entire platform exists to avoid.

import type { CoverageResponse, MatchupSummaryRow, ProvenanceResponse } from "@/lib/api/types";
import { snapshot } from "@/lib/session/permalink";
import { useSessionStore } from "@/state/useSessionStore";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick, not immediately: Safari has not started the
  // download by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Escape one CSV field, RFC 4180. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function provenanceHeader(prov: ProvenanceResponse | null, extra: string[]): string[] {
  const st = useSessionStore.getState();
  return [
    `# oceanUps export ${new Date().toISOString()}`,
    `# catalogue: ${prov?.catalogId ?? st.health?.catalogId ?? "unknown"}`,
    `# source: ${prov?.source ?? st.health?.source ?? "unknown"}`,
    `# synthetic: ${prov?.synthetic ?? st.health?.synthetic ?? "unknown"}`,
    ...extra.map((e) => `# ${e}`),
    `# ${prov?.disclaimer ?? "Research tool. Not an operational forecast or warning system."}`,
  ];
}

/** Per-instrument model-observation errors, as they are on screen. */
export function exportMatchupCsv(
  rows: MatchupSummaryRow[],
  prov: ProvenanceResponse | null,
): void {
  const st = useSessionStore.getState();
  const cols = ["platform", "id", "lat", "lon", "time", "dataMode", "bias", "rmse", "n"];
  const lines = [
    ...provenanceHeader(prov, [
      `variable: ${st.variable}`,
      "bias = model minus observation, at the observation depths",
      "QC: Argo reference table 2, flag 1 only (quantitative)",
      "n = observation levels that had model coverage",
    ]),
    cols.join(","),
    ...rows.map((r) => cols.map((c) => cell((r as unknown as Record<string, unknown>)[c])).join(",")),
  ];
  download(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }),
    `oceanups-matchup-${st.variable}-${stamp()}.csv`);
}

/** The assessment grid, one row per cell. */
export function exportCoverageCsv(
  cov: CoverageResponse,
  prov: ProvenanceResponse | null,
): void {
  const s = cov.summary;
  const cols = [
    "west", "south", "east", "north", "count", "platforms", "lastTime",
    "ageDays", "bias", "rmse", "levels", "confidence", "ocean", "blindSpot",
  ];
  const lines = [
    ...provenanceHeader(prov, [
      `variable: ${s.variable} (${s.units})`,
      `cell size: ${s.cellDeg} degrees; model grid ${s.gridDeg ?? "?"} degrees`,
      `freshness measured against ${s.referenceTime} (${s.referenceSource})`,
      `confidence = evidence x agreement, agreement = exp(-rmse/${s.sigma})`,
      `${s.observedCells}/${s.oceanCells} ocean cells observed`,
    ]),
    cols.join(","),
    ...cov.features.map((f) => {
      const ring = f.geometry.coordinates[0];
      const xs = ring.map((c) => c[0]);
      const ys = ring.map((c) => c[1]);
      const p = f.properties as unknown as Record<string, unknown>;
      return [
        Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
        ...cols.slice(4).map((c) =>
          c === "platforms" ? (p.platforms as string[]).join(" ") : p[c],
        ),
      ].map(cell).join(",");
    }),
  ];
  download(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }),
    `oceanups-assessment-${s.variable}-${stamp()}.csv`);
}

/** The whole session: what is on screen, plus what it was computed from. */
export function exportSessionJson(prov: ProvenanceResponse | null): void {
  const st = useSessionStore.getState();
  const body = {
    exported: new Date().toISOString(),
    application: "oceanUps (SIH 26067)",
    permalink: `${location.origin}${location.pathname}${location.hash}`,
    session: snapshot(),
    display: {
      colorRange: st.colorRange,
      logScale: st.logScale,
      colormap: st.colormapOverride,
    },
    matchup: st.matchup,
    coverageSummary: st.coverage?.summary ?? null,
    provenance: prov,
  };
  download(
    new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }),
    `oceanups-session-${stamp()}.json`,
  );
}

/**
 * The view, as a PNG.
 *
 * Both renderers need `preserveDrawingBuffer`, because WebGL is free to clear
 * the backbuffer the moment a frame is composited -- without it `toDataURL`
 * reliably returns a blank image, and does so with no error at all. That flag
 * is set where each context is created; this function only reads.
 *
 * The map and the block are separate canvases and only one is ever the subject,
 * so whichever is showing is the one captured.
 */
export async function exportViewPng(): Promise<void> {
  const st = useSessionStore.getState();
  const inBlock = st.phase === "block" || st.phase === "holding";
  const sel = inBlock ? "canvas[data-engine]" : ".maplibregl-canvas";
  const canvas = document.querySelector<HTMLCanvasElement>(sel);
  if (!canvas) throw new Error("no canvas to capture");

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("the renderer returned an empty frame");
  download(blob, `oceanups-${inBlock ? "block" : "map"}-${stamp()}.png`);
}
