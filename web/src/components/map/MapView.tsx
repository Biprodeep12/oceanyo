"use client";

import { useEffect, useRef, useState } from "react";
// maplibre-gl v6 has no default export.
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre parses GeoJSON in a Web Worker, and the worker is an ES module that
// imports a sibling chunk (`maplibre-gl-shared.mjs`) by RELATIVE path. Letting
// the bundler emit the worker breaks that: it hashes the worker into
// /_next/static/media/ without the sibling, the relative import 404s, the
// worker dies on load, and every GeoJSON source stays unloaded forever. Raster
// tiles keep working (images need no worker), so the map looks alive while the
// selection rectangle and observation markers silently never appear -- and
// MapLibre logs no error at all.
//
// Both files are therefore served verbatim from public/maplibre/, where the
// relative import resolves. See scripts/sync-maplibre-worker.mjs.
maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

import { api } from "@/lib/api/client";
import type { BBox } from "@/lib/api/types";
import { currentTime, useSessionStore } from "@/state/useSessionStore";

const FIELD_SOURCE = "ocean-field";
const FIELD_LAYER = "ocean-field-layer";
const OBS_SOURCE = "observations";
const SEL_SOURCE = "selection";

// The base style is INLINE and entirely local.
//
// Loading a remote style (even a keyless one) means MapLibre will not fire its
// `load` event until that style fully resolves -- and if the remote hangs, no
// sources or layers are ever added and the map renders nothing at all. That is
// exactly what happened here with the MapLibre demo tiles. On conference wifi
// it would be a dead demo.
//
// Basemap context is added AFTER load as a pure enhancement, so if it never
// arrives the ocean data is unaffected.
const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0a1a26" },
    },
  ],
};

// Deliberately NO remote basemap source. Adding one leaves the style
// permanently in "not loaded" state if the remote stalls, and MapLibre then
// refuses to render ANY vector layer -- the selection rectangle and the
// observation markers silently disappear while raster tiles keep working.
// Geographic context comes from a locally generated graticule instead, so the
// map has zero network dependencies beyond our own API.
function graticule(step = 5): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let lon = -180; lon <= 180; lon += step) {
    features.push({
      type: "Feature",
      properties: { label: `${Math.abs(lon)}${lon < 0 ? "W" : "E"}` },
      geometry: {
        type: "LineString",
        coordinates: [[lon, -85], [lon, 85]],
      },
    });
  }
  for (let lat = -80; lat <= 80; lat += step) {
    features.push({
      type: "Feature",
      properties: { label: `${Math.abs(lat)}${lat < 0 ? "S" : "N"}` },
      geometry: {
        type: "LineString",
        coordinates: [[-180, lat], [180, lat]],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

// MapLibre needs the literal {z}/{x}/{y} placeholders. Passing the template
// through `new URL()` percent-encodes the braces, MapLibre then finds no
// placeholders, and the source silently requests nothing at all.
function tileTemplate(variable: string, time: string, depth: number): string {
  return `${location.origin}${api.tileUrl(variable, time, depth)}`;
}

function selectionGeoJSON(bbox: BBox | null): GeoJSON.FeatureCollection {
  if (!bbox) return { type: "FeatureCollection", features: [] };
  const [w, s, e, n] = bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
        },
      },
      ...([[w, s], [e, s], [e, n], [w, n]] as [number, number][]).map((c, i) => ({
        type: "Feature" as const,
        properties: { handle: i },
        geometry: { type: "Point" as const, coordinates: c },
      })),
    ],
  };
}

export default function MapView({ visible }: { visible: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const dragHandle = useRef<number | null>(null);
  // React state, not a ref: the effects below populate the tile, observation
  // and selection sources, and they must RE-RUN once the style is live. A ref
  // flips silently and those effects would never fire again, leaving the
  // markers and the selection rectangle permanently invisible.
  const [ready, setReady] = useState(false);

  const variable = useSessionStore((s) => s.variable);
  const depth = useSessionStore((s) => s.depth);
  const selection = useSessionStore((s) => s.selection);
  const observations = useSessionStore((s) => s.observations);
  const errorById = useSessionStore((s) => s.errorById);
  const time = useSessionStore(currentTime);
  const setSelection = useSessionStore((s) => s.setSelection);

  // --- init ---
  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: BASE_STYLE,
      center: [88, 14],
      zoom: 4.6,
      attributionControl: { compact: true },
    });
    map.current = m;
    // debug handle (harmless in production, used by scripts/mapdbg.mjs)
    (window as unknown as { __map?: MLMap }).__map = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), "bottom-left");

    m.on("load", () => {
      m.addSource("graticule", { type: "geojson", data: graticule() });
      m.addLayer({
        id: "graticule-lines",
        type: "line",
        source: "graticule",
        paint: { "line-color": "#1d3546", "line-width": 1 },
      });

      m.addSource(FIELD_SOURCE, {
        type: "raster",
        tiles: [tileTemplate(variable, time ?? "latest", depth)],
        tileSize: 256,
        attribution: "SYNTHETIC data - not a reanalysis",
      });
      m.addLayer({
        id: FIELD_LAYER,
        type: "raster",
        source: FIELD_SOURCE,
        paint: { "raster-opacity": 0.85, "raster-fade-duration": 150 },
      });

      m.addSource(OBS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "obs-circles",
        type: "circle",
        source: OBS_SOURCE,
        paint: {
          "circle-radius": ["case", ["==", ["get", "platform"], "glider"], 3.5, 5],
          // Colour encodes model-observation error where we have it, so the
          // colour carries information rather than decoration.
          "circle-color": [
            "case",
            ["==", ["get", "err"], -1],
            "#8aa0b4",
            [
              "interpolate", ["linear"], ["get", "err"],
              0.0, "#3fb98a",
              0.35, "#e8c15a",
              0.8, "#e2603f",
            ],
          ],
          "circle-stroke-width": 1.2,
          "circle-stroke-color": "#0b1620",
          "circle-opacity": 0.95,
        },
      });

      m.addSource(SEL_SOURCE, { type: "geojson", data: selectionGeoJSON(null) });
      m.addLayer({
        id: "sel-fill",
        type: "fill",
        source: SEL_SOURCE,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#4fd1c5", "fill-opacity": 0.12 },
      });
      m.addLayer({
        id: "sel-line",
        type: "line",
        source: SEL_SOURCE,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": "#4fd1c5", "line-width": 2 },
      });
      m.addLayer({
        id: "sel-handles",
        type: "circle",
        source: SEL_SOURCE,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#0b1620",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#4fd1c5",
        },
      });

      setReady(true);
    });

    // --- corner-handle dragging ---
    m.on("mousedown", "sel-handles", (ev: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      ev.preventDefault();
      dragHandle.current = ev.features?.[0]?.properties?.handle ?? null;
      m.getCanvas().style.cursor = "grabbing";
    });
    m.on("mousemove", (ev: MapMouseEvent) => {
      if (dragHandle.current === null) return;
      const cur = useSessionStore.getState().selection;
      if (!cur) return;
      const { lng, lat } = ev.lngLat;
      const [w, s, e, n] = cur;
      // Handles are ordered [SW, SE, NE, NW].
      const next: BBox =
        dragHandle.current === 0 ? [lng, lat, e, n]
        : dragHandle.current === 1 ? [w, lat, lng, n]
        : dragHandle.current === 2 ? [w, s, lng, lat]
        : [lng, s, e, lat];
      setSelection([
        Math.min(next[0], next[2]), Math.min(next[1], next[3]),
        Math.max(next[0], next[2]), Math.max(next[1], next[3]),
      ]);
    });
    const endDrag = () => {
      if (dragHandle.current !== null) {
        dragHandle.current = null;
        m.getCanvas().style.cursor = "";
      }
    };
    m.on("mouseup", endDrag);
    m.on("mouseout", endDrag);
    m.on("mouseenter", "sel-handles", () => (m.getCanvas().style.cursor = "grab"));
    m.on("mouseleave", "sel-handles", () => (m.getCanvas().style.cursor = ""));

    // --- drag a fresh rectangle on shift+drag ---
    let anchor: [number, number] | null = null;
    m.on("mousedown", (ev: MapMouseEvent) => {
      if (!ev.originalEvent.shiftKey || dragHandle.current !== null) return;
      ev.preventDefault();
      anchor = [ev.lngLat.lng, ev.lngLat.lat];
      m.dragPan.disable();
    });
    m.on("mousemove", (ev: MapMouseEvent) => {
      if (!anchor) return;
      const [ax, ay] = anchor;
      setSelection([
        Math.min(ax, ev.lngLat.lng), Math.min(ay, ev.lngLat.lat),
        Math.max(ax, ev.lngLat.lng), Math.max(ay, ev.lngLat.lat),
      ]);
    });
    m.on("mouseup", () => {
      if (anchor) {
        anchor = null;
        m.dragPan.enable();
      }
    });

    return () => {
      m.remove();
      map.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- field tiles follow variable / depth / time ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(FIELD_SOURCE) as maplibregl.RasterTileSource | undefined;
    if (!src) return;
    src.setTiles([tileTemplate(variable, time ?? "latest", depth)]);
  }, [variable, depth, time, ready]);

  // --- observation markers ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(OBS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: observations.map((f) => ({
        ...f,
        properties: { ...f.properties, err: errorById[f.properties.id] ?? -1 },
      })),
    } as GeoJSON.FeatureCollection);
  }, [observations, errorById, ready]);

  // --- selection rectangle ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(SEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
    src?.setData(selectionGeoJSON(selection) as GeoJSON.FeatureCollection);
  }, [selection, ready]);

  // The map canvas stays mounted for the whole session and is only faded.
  // Remounting a WebGL context mid-animation is a guaranteed stutter.
  //
  // The positioning lives on the WRAPPER, not on the map element itself:
  // maplibre-gl.css declares `.maplibregl-map { position: relative }`, which
  // has the same specificity as Tailwind's `.absolute` and wins on source
  // order. That silently turned `absolute inset-0` into a static element with
  // height 0, and the map rendered nothing at all.
  return (
    <div
      className="absolute inset-0 transition-opacity duration-300"
      style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none" }}
    >
      <div ref={container} className="h-full w-full" />
    </div>
  );
}
