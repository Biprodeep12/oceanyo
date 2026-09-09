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
import { cachedGrid, loadGrid, probeKey, sampleGrid } from "@/lib/loading/fieldProbe";
import { shortLabel } from "@/lib/variableLabels";
import { registerViewport, releaseViewport } from "@/lib/viewport";
import { usePointer } from "@/state/usePointer";
import { currentTime, currentVariable, useSessionStore } from "@/state/useSessionStore";
import { useDisplaySettings } from "@/state/useDisplaySettings";

const FIELD_SOURCE = "ocean-field";
const FIELD_LAYER = "ocean-field-layer";
const LAND_SOURCE = "land";
const ANOM_SOURCE = "ocean-anomaly";
const ANOM_LAYER = "ocean-anomaly-layer";
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
function tileTemplate(
  variable: string,
  time: string,
  depth: number,
  display?: { range?: [number, number]; log?: boolean; colormap?: string },
): string {
  return `${location.origin}${api.tileUrl(variable, time, depth, display)}`;
}

function anomalyTemplate(variable: string, time: string, depth: number, limit: number) {
  return `${location.origin}${api.anomalyTileUrl(variable, time, depth, limit)}`;
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
  const showAnomaly = useSessionStore((s) => s.showAnomaly);
  const anomalyLimit = useSessionStore((s) => s.anomalyLimit);
  const climatologyVars = useSessionStore((s) => s.health?.climatology);
  const showObservations = useSessionStore((s) => s.showObservations);
  const varMeta = useSessionStore(currentVariable);
  const drawMode = useSessionStore((s) => s.drawMode);
  const setDrawMode = useSessionStore((s) => s.setDrawMode);
  const setDrawAnchor = useSessionStore((s) => s.setDrawAnchor);
  const time = useSessionStore(currentTime);
  const display = useDisplaySettings();
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
    // No NavigationControl: zoom lives in the right-hand rail, which also
    // drives the 3D camera in block mode. The scale bar stays -- reimplementing
    // Mercator scale correctly at every latitude is not worth the pixels saved.
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), "bottom-right");

    m.on("load", () => {
      m.addSource("graticule", { type: "geojson", data: graticule() });
      m.addLayer({
        id: "graticule-lines",
        type: "line",
        source: "graticule",
        paint: { "line-color": "#1d3546", "line-width": 1 },
      });

      // Land under the data, so the field reads as being in a place. Added
      // after load and tolerant of failure: it is context, never a dependency.
      m.addSource(LAND_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: "land-fill",
        type: "fill",
        source: LAND_SOURCE,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#1d2b23", "fill-opacity": 0.95 },
      });
      m.addLayer({
        id: "land-line",
        type: "line",
        source: LAND_SOURCE,
        paint: { "line-color": "#3d5647", "line-width": 1.1 },
      });

      m.addSource(FIELD_SOURCE, {
        type: "raster",
        tiles: [tileTemplate(variable, time ?? "latest", depth, display)],
        tileSize: 256,
        attribution: "SYNTHETIC data - not a reanalysis",
      });
      m.addLayer({
        id: FIELD_LAYER,
        type: "raster",
        source: FIELD_SOURCE,
        paint: { "raster-opacity": 0.85, "raster-fade-duration": 150 },
      });

      // Anomaly sits directly above the field layer and below the vectors,
      // so toggling it swaps what the ocean is coloured by without disturbing
      // the selection rectangle or the instrument markers.
      m.addSource(ANOM_SOURCE, {
        type: "raster",
        tiles: [anomalyTemplate(variable, time ?? "latest", depth, anomalyLimit)],
        tileSize: 256,
      });
      m.addLayer({
        id: ANOM_LAYER,
        type: "raster",
        source: ANOM_SOURCE,
        layout: { visibility: "none" },
        paint: { "raster-opacity": 0.9, "raster-fade-duration": 150 },
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

  // --- coastline, fetched once ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const ac = new AbortController();
    api
      .coastline(ac.signal)
      .then((fc) => {
        const src = m.getSource(LAND_SOURCE) as maplibregl.GeoJSONSource | undefined;
        src?.setData(fc as GeoJSON.FeatureCollection);
      })
      .catch(() => {
        /* context only: a map without it is still a working map */
      });
    return () => ac.abort();
  }, [ready]);

  // --- field tiles follow variable / depth / time ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(FIELD_SOURCE) as maplibregl.RasterTileSource | undefined;
    if (!src) return;
    src.setTiles([tileTemplate(variable, time ?? "latest", depth, display)]);
    // MapLibre keeps showing the old tiles until new ones arrive, so a colour
    // change reads as a cross-fade rather than a flash of empty map.
  }, [variable, depth, time, ready, display]);

  // --- anomaly overlay ---
  //
  // Gated on the catalog actually having a climatology for THIS variable. The
  // toggle can stay on while the user switches to chlorophyll or a velocity
  // component, and without this the layer would keep requesting tiles that
  // correctly 404.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const visible = showAnomaly && (climatologyVars ?? []).includes(variable);
    m.setLayoutProperty(ANOM_LAYER, "visibility", visible ? "visible" : "none");
    if (!visible) return;
    const src = m.getSource(ANOM_SOURCE) as maplibregl.RasterTileSource | undefined;
    src?.setTiles([anomalyTemplate(variable, time ?? "latest", depth, anomalyLimit)]);
  }, [showAnomaly, anomalyLimit, variable, depth, time, ready, climatologyVars]);

  // --- observation markers ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    m.setLayoutProperty("obs-circles", "visibility", showObservations ? "visible" : "none");
    const src = m.getSource(OBS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: observations.map((f) => ({
        ...f,
        properties: { ...f.properties, err: errorById[f.properties.id] ?? -1 },
      })),
    } as GeoJSON.FeatureCollection);
  }, [observations, errorById, ready, showObservations]);

  // --- selection rectangle ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(SEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
    src?.setData(selectionGeoJSON(selection) as GeoJSON.FeatureCollection);
  }, [selection, ready]);

  // --- tap two corners to draw a region ---
  //
  // Shift+drag cannot exist on a touch screen: there is no shift, and a drag
  // is a pan. Two taps work on every input device, so this is the primary way
  // to select a region and shift+drag is the shortcut, not the only path.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !drawMode) return;
    m.getCanvas().style.cursor = "crosshair";
    let anchor: [number, number] | null = null;

    const onClick = (ev: MapMouseEvent) => {
      const point: [number, number] = [ev.lngLat.lng, ev.lngLat.lat];
      if (!anchor) {
        anchor = point;
        setDrawAnchor(point);
        return;
      }
      setSelection([
        Math.min(anchor[0], point[0]),
        Math.min(anchor[1], point[1]),
        Math.max(anchor[0], point[0]),
        Math.max(anchor[1], point[1]),
      ]);
      anchor = null;
      setDrawMode(false);
    };

    m.on("click", onClick);
    return () => {
      m.off("click", onClick);
      m.getCanvas().style.cursor = "";
    };
  }, [drawMode, ready, setSelection, setDrawMode, setDrawAnchor]);

  // --- the rail owns zoom, and this is what it drives in map mode ---
  useEffect(() => {
    const m = map.current;
    if (!m || !visible) return;
    const handlers = {
      zoomIn: () => m.zoomIn({ duration: 220 }),
      zoomOut: () => m.zoomOut({ duration: 220 }),
      reset: () => m.easeTo({ center: [88, 14] as [number, number], zoom: 4.6, duration: 500 }),
    };
    registerViewport(handlers);
    return () => releaseViewport(handlers);
  }, [visible, ready]);

  // --- pointer readout: one grid per selection, sampled locally ---
  //
  // Fetching a value per pointer move would be thousands of round trips. One
  // decimated grid covering the whole extent is pulled when the variable,
  // depth or time changes, and every move after that is a local bilinear
  // sample.
  const probe = probeKey(variable, depth, time);
  useEffect(() => {
    if (!visible) return;
    void loadGrid(probe, { variable, depth, time, res: 160 });
  }, [probe, variable, depth, time, visible]);

  useEffect(() => {
    if (!visible) usePointer.getState().clear();
  }, [visible]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    // Coalesced to one update per animation frame: a mousemove handler that
    // writes on every event fires far more often than the screen refreshes.
    let frame = 0;
    let pending: { x: number; y: number; lng: number; lat: number } | null = null;

    const flush = () => {
      frame = 0;
      if (!pending) return;
      const grid = cachedGrid(probe);
      const value = grid ? sampleGrid(grid, pending.lng, pending.lat) : null;
      usePointer.getState().set({
        x: pending.x,
        y: pending.y,
        lon: pending.lng,
        lat: pending.lat,
        value,
        units: grid?.units ?? varMeta?.units ?? "",
        label: shortLabel(variable, varMeta?.longName),
        visible: true,
      });
    };

    const onMove = (ev: MapMouseEvent) => {
      pending = {
        x: ev.point.x,
        y: ev.point.y,
        lng: ev.lngLat.lng,
        lat: ev.lngLat.lat,
      };
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const onOut = () => usePointer.getState().clear();

    m.on("mousemove", onMove);
    m.on("mouseout", onOut);
    // A touch screen never hovers, so a tap has to do the same job. Skipped
    // while drawing a region, where a tap means "corner", not "read value".
    const onTap = (ev: MapMouseEvent) => {
      if (useSessionStore.getState().drawMode) return;
      onMove(ev);
    };
    m.on("click", onTap);
    return () => {
      m.off("mousemove", onMove);
      m.off("mouseout", onOut);
      m.off("click", onTap);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [probe, variable, varMeta, ready]);

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
      className={`absolute inset-0 transition-opacity duration-300${visible ? "" : " ze-inert"}`}
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div ref={container} className="h-full w-full" />
    </div>
  );
}
