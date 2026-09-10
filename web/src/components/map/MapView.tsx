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
import { openProfile } from "@/lib/api/openProfile";
import { token, tokenNumber } from "@/lib/theme";
import { inTimeWindow, windowDaysFor } from "@/lib/geo/obsWindow";
import { coverageStyle } from "@/lib/geo/coverageStyle";
import { currentTime, currentVariable, useSessionStore } from "@/state/useSessionStore";
import { useDisplaySettings } from "@/state/useDisplaySettings";

const FIELD_SOURCE = "ocean-field";
const FIELD_LAYER = "ocean-field-layer";
const LAND_SOURCE = "land";
const ANOM_SOURCE = "ocean-anomaly";
const ANOM_LAYER = "ocean-anomaly-layer";
const COV_SOURCE = "assessment";
const COV_FILL = "assessment-fill";
const COV_LINE = "assessment-line";
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
  sources: {
    // Natural Earth II, public domain, served from our own /public. Zoom 0-4;
    // MapLibre overzooms past that, which is fine for context.
    basemap: {
      type: "raster",
      tiles: ["/basemap/{z}/{x}/{y}.jpg"],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 4,
      attribution: "Land: Natural Earth II (public domain)",
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0a1a26" },
    },
    {
      id: "basemap",
      type: "raster",
      source: "basemap",
      // Dimmed and desaturated: this is context, not the subject. At full
      // strength it competes with the field for attention and the colour scale
      // stops being readable against it.
      paint: { "raster-opacity": 0.42, "raster-saturation": -0.55, "raster-brightness-max": 0.8 },
    },
  ],
};

// Still NO REMOTE basemap. A remote source leaves the style permanently in
// "not loaded" state if it stalls, and MapLibre then refuses to render ANY
// vector layer -- the selection rectangle and the observation markers silently
// disappear while raster tiles keep working. These tiles are bundled in
// web/public, so the map has zero network dependencies beyond our own origin,
// and they answer the first question anyone asks of a regional subset: what is
// the empty part? Without them the ocean outside the domain is an unexplained
// void that reads as a broken renderer rather than as "no data here".
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

/**
 * The selection, as a polygon plus one point per draggable corner.
 *
 * A quad, when there is one, is drawn INSTEAD of its bounding box rather than
 * on top of it. Drawing both would be more informative and much worse: the
 * rectangle is what the server slices and the quad is what the block shows, so
 * two outlines on screen would leave the user to guess which one the data
 * belongs to.
 */
function selectionGeoJSON(
  bbox: BBox | null,
  quad: [number, number][] | null,
  pending: [number, number][] = [],
): GeoJSON.FeatureCollection {
  const corners: [number, number][] =
    quad && quad.length === 4
      ? quad
      : bbox
        ? [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[3]],
          ]
        : [];

  const features: GeoJSON.Feature[] = [];
  if (corners.length === 4) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[...corners, corners[0]]] },
    });
    // Handles are only draggable on a rectangle: on a quad a corner drag would
    // have to choose between moving one point and keeping the shape convex,
    // and a selection that silently self-intersects produces a clip nobody can
    // reason about. Re-drawing four corners is two seconds.
    if (!quad) {
      corners.forEach((c, i) =>
        features.push({
          type: "Feature",
          properties: { handle: i },
          geometry: { type: "Point", coordinates: c },
        }),
      );
    }
  }
  // Corners placed so far, while a quad is still being drawn.
  pending.forEach((c, i) =>
    features.push({
      type: "Feature",
      properties: { pending: i },
      geometry: { type: "Point", coordinates: c },
    }),
  );
  return { type: "FeatureCollection", features };
}

/** Axis-aligned bounds of a set of corners -- what the server is actually asked for. */
function quadBounds(q: [number, number][]): BBox {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
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

  const domain = useSessionStore((s) => s.domain);
  const times = useSessionStore((s) => s.times);
  const theme = useSessionStore((s) => s.theme);
  const selectedProfile = useSessionStore((s) => s.selectedProfile);
  const variable = useSessionStore((s) => s.variable);
  const depth = useSessionStore((s) => s.depth);
  const selection = useSessionStore((s) => s.selection);
  const observations = useSessionStore((s) => s.observations);
  const errorById = useSessionStore((s) => s.errorById);
  const showAnomaly = useSessionStore((s) => s.showAnomaly);
  const coverageMetric = useSessionStore((s) => s.coverageMetric);
  const coverage = useSessionStore((s) => s.coverage);
  const anomalyLimit = useSessionStore((s) => s.anomalyLimit);
  const climatologyVars = useSessionStore((s) => s.health?.climatology);
  const showObservations = useSessionStore((s) => s.showObservations);
  const varMeta = useSessionStore(currentVariable);
  const drawMode = useSessionStore((s) => s.drawMode);
  const drawShape = useSessionStore((s) => s.drawShape);
  const selectionQuad = useSessionStore((s) => s.selectionQuad);
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
      // Required for the PNG export. Without it the canvas reads back blank,
      // silently -- see lib/report/export.ts. MapLibre 6 moved the WebGL
      // context attributes behind `canvasContextAttributes`; passing the flag
      // at the top level, as v4 took it, is silently ignored.
      canvasContextAttributes: { preserveDrawingBuffer: true },
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
        // Read at source-creation time from whatever catalog is loaded; a
        // hardcoded string here mislabels real data.
        attribution:
          useSessionStore.getState().health?.synthetic === false
            ? (useSessionStore.getState().health?.source ?? "model field")
            : "SYNTHETIC data - not a reanalysis",
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

      // The assessment grid: coverage, blind spots, accuracy, bias, confidence
      // and freshness are one source styled six ways, so switching between
      // them never refetches and the cells never move under the cursor.
      m.addSource(COV_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      m.addLayer({
        id: COV_FILL,
        type: "fill",
        source: COV_SOURCE,
        layout: { visibility: "none" },
        paint: { "fill-color": "rgba(0,0,0,0)", "fill-opacity": 0.72 },
      });
      m.addLayer({
        id: COV_LINE,
        type: "line",
        source: COV_SOURCE,
        layout: { visibility: "none" },
        paint: {
          "line-color": "rgba(255,255,255,0.14)",
          "line-width": 0.6,
        },
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

      // The selected instrument, drawn as a ring ABOVE the markers.
      //
      // A marker that opens a 360px panel has to be findable again afterwards:
      // among a hundred identical dots there is nothing to say which one the
      // profile belongs to, and after the map pans there is nothing to say
      // where it went.
      m.addLayer({
        id: "obs-selected",
        type: "circle",
        source: OBS_SOURCE,
        filter: ["==", ["get", "id"], " none"],
        paint: {
          "circle-radius": 11,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2.4,
          "circle-stroke-color": "#4fd1c5",
          "circle-stroke-opacity": 0.95,
        },
      });

      m.addSource(SEL_SOURCE, {
        type: "geojson",
        data: selectionGeoJSON(null, null),
      });
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

  // --- frame the map to the data, once the catalog says how big it is ---
  //
  // The opening view was a hardcoded centre and zoom, tuned by eye on one
  // laptop. Zoom is independent of viewport WIDTH, so the same 4.6 that filled
  // a 1440px window leaves the same data as a small tile in the middle of a
  // 1920px one -- and because this platform draws no basemap beyond its own
  // subset (deliberately: nothing to stall on a third-party tile server during
  // a demo), everything around it is empty. It reads as a broken map rather
  // than as a regional dataset. Fitting to the catalog's own extent is right on
  // any screen, and right for any region a future catalog covers.
  // Stay framed to the data until the user takes the wheel.
  //
  // A one-shot fit is not enough. fitBounds derives zoom from the container's
  // size AT THAT MOMENT, and MapLibre then holds zoom rather than extent -- so
  // if the container is still settling (or the window is later resized, or a
  // panel opens) the data shrinks back into a corner of a big empty map, which
  // is the symptom this exists to cure. Re-fitting on every resize until the
  // first real drag or zoom keeps it right on any screen without ever fighting
  // someone who has started exploring.
  const userMoved = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !domain) return;

    const fit = () => {
      if (userMoved.current) return;
      const el = m.getContainer();
      if (el.clientWidth < 100 || el.clientHeight < 100) return;
      const [w, s0, e, n] = domain;
      m.fitBounds(
        [
          [w, s0],
          [e, n],
        ],
        { padding: 48, duration: 0 },
      );
    };

    // Only a gesture counts as taking control; fitBounds itself fires these
    // events with no originalEvent, and treating that as user intent would
    // disarm the framing on its very first call.
    const claim = (ev: { originalEvent?: unknown }) => {
      if (ev?.originalEvent) userMoved.current = true;
    };

    m.on("dragstart", claim);
    m.on("zoomstart", claim);
    m.on("rotatestart", claim);
    m.on("resize", fit);

    // A ResizeObserver on the CONTAINER, not just MapLibre's own resize event.
    // MapLibre only tracks the WINDOW, so a container that settles during
    // layout -- fonts loading, a panel measuring itself, the flex row settling
    // -- never fires it. That is the common case on a first paint, and it is
    // why the one-shot fit kept leaving the data small in a large window while
    // resizing the window by hand appeared to "fix" it.
    const ro = new ResizeObserver(() => {
      m.resize();
      fit();
    });
    ro.observe(m.getContainer());

    const id = requestAnimationFrame(fit);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
      m.off("dragstart", claim);
      m.off("zoomstart", claim);
      m.off("rotatestart", claim);
      m.off("resize", fit);
    };
  }, [ready, domain]);

  // --- theme: repaint the layers MapLibre owns ---
  //
  // MapLibre takes literal values, not var(--x). The land raster needs more
  // than a colour swap: dimmed and desaturated it reads as context under a dark
  // field, but the same treatment on a light ground turns the continents into
  // grey mud. Opacity, saturation and brightness are all tokens.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    try {
      m.setPaintProperty("background", "background-color", token("--ze-ocean", "#06121c"));
      m.setPaintProperty("basemap", "raster-opacity", tokenNumber("--ze-basemap-opacity", 0.42));
      m.setPaintProperty("basemap", "raster-saturation", tokenNumber("--ze-basemap-saturation", -0.55));
      m.setPaintProperty("basemap", "raster-brightness-max", tokenNumber("--ze-basemap-brightness", 0.8));
      m.setPaintProperty("land-fill", "fill-color", token("--ze-land", "#16232e"));
      m.setPaintProperty("land-line", "line-color", token("--ze-land-edge", "#22384a"));
    } catch {
      /* a layer this style does not have is not an error worth surfacing */
    }
  }, [theme, ready]);

  // --- follow the selection: ring it, and bring it into view ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const id = selectedProfile?.id;
    try {
      // A literal that no id can equal, so "nothing selected" hides the ring.
      m.setFilter("obs-selected", ["==", ["get", "id"], id ?? " none"]);
    } catch {
      /* style not ready */
    }
    if (!selectedProfile) return;

    // Ease, never jump, and only zoom IN. Yanking someone from a basin view to
    // z8 loses the context that made the float interesting; refusing to zoom
    // out preserves a closer view they chose themselves.
    const target = Math.max(m.getZoom(), 5.5);
    userMoved.current = true; // an explicit move; stop auto-fitting to the domain
    m.easeTo({
      center: [selectedProfile.lon, selectedProfile.lat],
      zoom: target,
      duration: 700,
      // Keep it clear of the 360px panel on the right and the layers panel.
      padding: { left: 280, right: 400, top: 40, bottom: 120 },
    });
  }, [selectedProfile, ready]);

  // --- click an instrument on the MAP, not only in the block ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const onPick = (ev: maplibregl.MapLayerMouseEvent) => {
      if (useSessionStore.getState().drawMode) return;
      const f = ev.features?.[0];
      if (!f) return;
      const { platform, id } = f.properties as { platform: string; id: string };
      // Stop the region-draw and pointer-readout handlers treating this as a
      // click on the sea surface.
      ev.preventDefault?.();
      void openProfile(platform, id);
    };
    const enter = () => (m.getCanvas().style.cursor = "pointer");
    const leave = () => (m.getCanvas().style.cursor = "");
    m.on("click", "obs-circles", onPick);
    m.on("mouseenter", "obs-circles", enter);
    m.on("mouseleave", "obs-circles", leave);
    return () => {
      m.off("click", "obs-circles", onPick);
      m.off("mouseenter", "obs-circles", enter);
      m.off("mouseleave", "obs-circles", leave);
    };
  }, [ready]);

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
        // The locator inset draws the same rings, so it is shared rather than
        // fetched twice.
        useSessionStore.getState().setCoastline(fc as GeoJSON.FeatureCollection);
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

  // --- assessment grid: fetch ---
  //
  // Keyed on the DOMAIN, not the selection: these layers answer "where is the
  // observing network thin" and "where is the model weak", which are questions
  // about the whole region a user is choosing within. Refetching them on every
  // corner drag would also make the most expensive endpoint the twitchiest.
  useEffect(() => {
    if (!coverageMetric) return;
    const ac = new AbortController();
    const st = useSessionStore.getState();
    st.setLoadingCoverage(true);
    api
      .coverage({ variable, bbox: domain ?? undefined }, ac.signal)
      .then((c) => useSessionStore.getState().setCoverage(c))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") console.warn("coverage:", e);
      })
      .finally(() => useSessionStore.getState().setLoadingCoverage(false));
    return () => ac.abort();
  }, [coverageMetric, variable, domain]);

  // --- assessment grid: draw ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const on = Boolean(coverageMetric);
    for (const id of [COV_FILL, COV_LINE]) {
      m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
    if (!on || !coverageMetric) return;
    const src = m.getSource(COV_SOURCE) as maplibregl.GeoJSONSource | undefined;
    src?.setData(
      (coverage ?? { type: "FeatureCollection", features: [] }) as GeoJSON.FeatureCollection,
    );
    const { paint } = coverageStyle(coverageMetric, coverage);
    m.setPaintProperty(COV_FILL, "fill-color", paint as never);
  }, [coverageMetric, coverage, ready]);

  // --- assessment grid: what one cell says ---
  //
  // The layer shows a pattern; a reviewer immediately asks for the number
  // behind one square. Hovering answers that without a click, and without a
  // panel that has to be dismissed.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !coverageMetric) return;
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "ze-map-popup",
      offset: 8,
    });
    const move = (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const p = e.features?.[0]?.properties as Record<string, unknown> | undefined;
      if (!p) return;
      const num = (k: string, digits = 2, unit = "") =>
        typeof p[k] === "number" ? `${(p[k] as number).toFixed(digits)}${unit}` : "&mdash;";
      const u = coverage?.summary.units ?? "";
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${p.count ?? 0} profile${p.count === 1 ? "" : "s"}</b>` +
            `<br/>bias ${num("bias", 3, ` ${u}`)} &middot; RMSE ${num("rmse", 3)}` +
            `<br/>confidence ${num("confidence")} &middot; age ${num("ageDays", 0, " d")}` +
            (p.lastTime ? `<br/>last ${String(p.lastTime).slice(0, 10)}` : "") +
            (p.blindSpot ? `<br/><i>unobserved ocean</i>` : ""),
        )
        .addTo(m);
    };
    const leave = () => popup.remove();
    m.on("mousemove", COV_FILL, move);
    m.on("mouseleave", COV_FILL, leave);
    return () => {
      m.off("mousemove", COV_FILL, move);
      m.off("mouseleave", COV_FILL, leave);
      popup.remove();
    };
  }, [coverageMetric, coverage, ready]);

  // --- observation markers ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    m.setLayoutProperty("obs-circles", "visibility", showObservations ? "visible" : "none");
    const src = m.getSource(OBS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      // Only the instruments contemporaneous with the timestep on screen.
      features: inTimeWindow(observations, time, windowDaysFor(times)).map((f) => ({
        ...f,
        properties: { ...f.properties, err: errorById[f.properties.id] ?? -1 },
      })),
    } as GeoJSON.FeatureCollection);
  }, [observations, errorById, ready, showObservations, time, times]);

  // --- selection rectangle ---
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const src = m.getSource(SEL_SOURCE) as maplibregl.GeoJSONSource | undefined;
    src?.setData(
      selectionGeoJSON(selection, selectionQuad) as GeoJSON.FeatureCollection,
    );
  }, [selection, selectionQuad, ready]);

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
    const corners: [number, number][] = [];
    const src = () => m.getSource(SEL_SOURCE) as maplibregl.GeoJSONSource | undefined;

    const onClick = (ev: MapMouseEvent) => {
      const point: [number, number] = [ev.lngLat.lng, ev.lngLat.lat];

      if (drawShape === "quad") {
        corners.push(point);
        if (corners.length < 4) {
          // Show the corners as they land. Four blind clicks and then a shape
          // is not a drawing tool, it is a guess.
          setDrawAnchor(point);
          src()?.setData(
            selectionGeoJSON(null, null, [...corners]) as GeoJSON.FeatureCollection,
          );
          return;
        }
        const quad = [...corners] as [number, number][];
        const st = useSessionStore.getState();
        // Order matters: setSelection clears the quad, so the bounds go first.
        st.setSelection(quadBounds(quad));
        st.setSelectionQuad(quad);
        corners.length = 0;
        setDrawAnchor(null);
        setDrawMode(false);
        return;
      }

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
  }, [drawMode, drawShape, ready, setSelection, setDrawMode, setDrawAnchor]);

  // --- the rail owns zoom, and this is what it drives in map mode ---
  useEffect(() => {
    const m = map.current;
    if (!m || !visible) return;
    const handlers = {
      zoomIn: () => m.zoomIn({ duration: 220 }),
      zoomOut: () => m.zoomOut({ duration: 220 }),
      reset: () => {
        const d = useSessionStore.getState().domain;
        if (d) {
          m.fitBounds(
            [
              [d[0], d[1]],
              [d[2], d[3]],
            ],
            { padding: 48, duration: 500 },
          );
        } else {
          m.easeTo({ center: [88, 14] as [number, number], zoom: 4.6, duration: 500 });
        }
      },
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
