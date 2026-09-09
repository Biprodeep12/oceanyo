# SIH 26067 — Revised, Prompt-Ready Technical Specification (v2)
## Interactive Ocean Data Visualization & Model–Observation Intelligence Platform
**For:** Ministry of Earth Sciences / INCOIS, Ocean Valley · **Category:** Software · **Theme:** Disaster Management

> **v2 changes:** the always-on 3D scene is replaced by a **2D map → region selection → extruded 3D block** interaction model, and a new §5.1 defines the smooth-loading strategy for that block.

---

## TL;DR

- **No full 3D globe, and no permanent 3D scene.** Default to a **2D map of the Indian EEZ**. The user selects a region on it, and that footprint **extrudes downward into a 3D lat–lon–depth block** (Three.js) showing the water column, depth layers, seabed and Argo/glider observations in true 3D. The problem statement explicitly permits "WebGL / Three.js **or** Cesium.js", so this is fully compliant — and it makes depth-slices, isosurfaces, vertical exaggeration and the virtual dive far easier than fighting a curved ellipsoid. **The extrude transition is the platform's single best demo moment.**
- **Re-tier the features to match the statement's stated core.** Isosurface extraction, true volumetric rendering, the CTD/BGC-capable data model, chlorophyll as a first-class variable, and the plugin/extensibility architecture move **into** the MVP; the AI assistant, eddy tracker, story mode and what-if simulation move **out**. Keep **model-vs-observation comparison** as the scientific differentiator, made defensible with proper matchup metrics.
- **Ground the build in real, current tooling:** GLORYS12V1 via the `copernicusmarine` toolbox (MOTU is deprecated), Argo via `argopy`, gliders via the EGO/OceanGliders GDAC; OGC WMS + OPeNDAP via `xpublish` + `xpublish-wms`; CF coordinate detection via `cf-xarray`; and position any drift feature as **complementary to INCOIS's operational SARAT**, never as a warning system.

---

## Part I — Research Findings & Recommendations

### A. Gap check against the problem statement

**(i) Requirements the draft under-emphasises, mis-tiers, or omits:**

| Statement requirement | Draft treatment | Correct placement |
|---|---|---|
| **True 3D volumetric rendering + isosurface extraction** ("depth-resolved volumetric views", "isosurface extraction") | Draft lists depth-slices and a basic cross-section only; no isosurface | **MVP.** Ray-marched volume + server-side isosurface |
| **CTD and BGC data** (named in the instrument-overlay requirement) | Deferred to Level 3 plugin | **MVP for the data model**; shipping datasets can be Argo + glider first |
| **Chlorophyll** (first-class in the statement) | Treated as a glider-only extra | **First-class variable** alongside T/S/currents |
| **OPeNDAP, OGC WMS/WCS, CF Conventions** | Only named in the architecture diagram | **Explicit MVP acceptance criteria** |
| **"No client-side dependencies" / platform-independent** | Implied | **Hard non-functional requirement** |
| **Plugin/extensibility** (core in the statement) | Pushed to Level 3 | **MVP architecture** (parser registry + common data model) |

**(ii) Over-scope relative to the statement:** the AI ocean assistant, Ocean Detective Mode, automatic feature detection, eddy tracker, story mode and what-if simulation are *not requested*. Good future vision; must not consume MVP hours.

**(iii) Does the draft MVP satisfy an INCOIS evaluator under a Disaster Management theme?** Not yet. It is a competent visualiser but connects weakly to the operational mandates the statement names (hazard assessment, search-and-rescue, fishery advisories, climate monitoring). Fix: (a) surface a defensible **anomaly / marine-heatwave** layer, and (b) frame the demo around a real INCOIS disaster workflow (e.g. the June 2025 *Wan Hai 503* container-ship fire off Kozhikode, where INCOIS activated SARAT and its Oil Spill Trajectory System). Position the platform as the **co-visualisation and validation layer** operational tools currently lack.

### B. Rendering primitive — decision

**Recommended: 2D map by default, extruded regional 3D block on selection. Fallback: CesiumJS with a constrained camera.**

- **The statement permits it.** It offers "WebGL / Three.js **or** Cesium.js".
- **Datasets are regional, not global** (Indian Ocean / EEZ / Bay of Bengal / Arabian Sea). A block renders the water column on a true Cartesian depth axis, so depth-slices, isosurfaces, vertical exaggeration and cross-sections are natural. On a globe they are awkward.
- **Subsurface on a globe is genuinely hard.** CesiumJS 1.70 (June 2020, with Camptocamp for swisstopo) added globe translucency and free underground camera movement, but underground navigation, depth-plane clipping artefacts and culling remain rough. Cesium is fundamentally a surface-and-globe engine; volumetric water columns are not what it is built for.
- **Curvature distorts a bounded regional volume** and complicates vertical exaggeration. deck.gl's `GlobeView` is still experimental — no pitch/bearing support, and known rendering issues when mixing `GlobeView` and `MapView`.
- **Selection-scoped 3D is also a performance win:** you only ever hold one user-chosen subset in GPU memory instead of a whole region.
- **What you lose without a globe:** the "explore anywhere" first-sight wow. **Recover it cheaply** with a small globe/locator inset and an optional globe→map fly-in on first load.

**Four arbitrary points vs an axis-aligned rectangle.** A rotated or irregular quadrilateral no longer aligns with the model's lat/lon grid, so the backend must resample onto a new grid before rendering — extra interpolation code and a slower first paint. An axis-aligned rectangle is a direct array slice (`ds.sel(longitude=slice(x0,x1), latitude=slice(y0,y1))` — GLORYS names them in full), which is free. **Ship the rectangle for the MVP with four draggable corner handles** so it still feels like point selection; keep the arbitrary quad as Level 2.

### C. Technical research grounding

1. **Browser volume rendering.** Ray-march a 3D texture inside a rasterised bounding box in a GLSL fragment shader, with a transfer function for colour/opacity (Will Usher, "Volume Rendering with WebGL"). The official three.js `webgl_texture3d` example renders a 128×128×256 float NRRD volume (~16.8 MB) with MIP and isosurface modes — direct proof the approach works. **Limits:** the WebGL2 `MAX_3D_TEXTURE_SIZE` spec floor is **256** (OpenGL ES 3.0); desktop NVIDIA reports 16384, AMD 2048 on Windows / 8192 on Linux. A 256³ float32 volume is ~67 MB. **Keep browser volumes ≤256³** and subset server-side.
2. **Isosurface extraction — server-side.** Use `skimage.measure.marching_cubes` (Lewiner MC33; `step_size` is the decimation knob) or PyVista/VTK, and export a compact glTF mesh. Client-side `THREE.MarchingCubes` targets metaball/implicit surfaces, not arbitrary scalar fields; scientific isosurfacing of large volumes is impractical in single-threaded JS.
3. **Animated current particles.** Use the GPU velocity-texture technique from Vladimir Agafonkin's `mapbox/webgl-wind` and the earth.nullschool lineage (`astrosat/windgl`, Esri Wind-JS): encode u/v into R/G channels with min/max metadata, hold particle positions in a framebuffer texture, advect on the GPU, fade trails. **Make it depth-aware** by loading the velocity texture for the selected depth level.
4. **Serving NetCDF to the browser + standards compliance.** Lowest-effort path to OGC WMS + OPeNDAP: FastAPI + **`xpublish`** with **`xpublish-wms`** (serves OGC WMS directly from a CF-compliant xarray dataset; needs lat/lon/time/vertical coordinate variables) and **`xpublish-opendap`**. Pre-process to **Zarr** for fast chunked reads; `kerchunk`/`virtualizarr` build a virtual Zarr over existing NetCDF without copying. **What OPeNDAP gives a browser:** remote subsetting, but a binary DAP response a browser can't consume — so **consume OPeNDAP server-side** (e.g. from INCOIS LAS) and expose your own REST/JSON + PNG tiles. TiTiler (`titiler.xarray`) is the alternative dynamic tiler.
5. **Getting the actual data.**
   - **INCOIS Live Access Server (las.incois.gov.in):** Ferret-based LAS with a THREDDS Data Server (4.3.10) exposing OPeNDAP under `las.incois.gov.in/thredds/dodsC/las/`. Serves Indian-Ocean satellite SST, surface chlorophyll, winds, objectively-analysed in-situ products, GODAS-MOM model analysis and WOA09 climatology.
   - **Copernicus `GLOBAL_MULTIYEAR_PHY_001_030` (GLORYS12V1):** global eddy-resolving reanalysis, **1/12° (≈9 km at the equator), 50 vertical levels**, with **22 of the 50 levels in the top 100 m** (Storer et al., arXiv:2311.09100), from **1993 onward** (coverage reported through December 2024). Daily and monthly mean temperature, salinity, currents (`uo`/`vo`), sea level and mixed-layer depth. DOI 10.48670/moi-00021. Download with the **`copernicusmarine`** Python toolbox `subset()` (bbox + depth + time; ARCO Zarr or NetCDF). **MOTU is deprecated.** Free registration required.
   - **Argo GDAC (ftp.ifremer.fr / data-argo.ifremer.fr):** `dac/`, `geo/`, `latest_data/` with index files (`ar_index_global_prof.txt`; `argo_synthetic-profile_index.txt.gz` for BGC). Use **`argopy`** — `DataFetcher().region([lon0,lon1,lat0,lat1,z0,z1,'t0','t1'])` or `.float(WMO)`. QC flags: **1 = good, 2 = probably good**; `mode='research'` returns delayed-mode data with QC = 1. Keep 1 and 2 for display; only 1 for quantitative validation.
   - **Glider DAC (ftp.ifremer.fr/ifremer/glider/v2):** **EGO glider NetCDF** (Ifremer reference manual DOI 10.13155/34980; format version **1.5** since April 2025), one file per deployment, stored as time-series with descent/ascent split into two profiles. **Indian-Ocean deployments are sparse — verify availability early.**
   - **Chlorophyll — needs a separate product.** GLORYS12 is physics-only (T/S/currents/SSH/MLD); it carries **no biogeochemistry**. For model chlorophyll use the Copernicus global BGC reanalysis **`GLOBAL_MULTIYEAR_BGC_001_029`** (`chl`, plus nutrients and oxygen), downloaded the same way via `copernicusmarine subset` — note it is **coarser (1/4°) and lower-frequency than GLORYS12**, so the chlorophyll layer will not share a grid with temperature/salinity and must be regridded or rendered on its own axes. For observed chlorophyll use **BGC-Argo synthetic profiles** (a different index — `argo_synthetic-profile_index.txt.gz` — and `argopy` with `ds='bgc'`), or surface chlorophyll from INCOIS LAS. **If BGC data proves slow to obtain, drop chlorophyll to Level 2** rather than shipping a variable with no source.
   - **Missing "Collection of In-situ Data" link — substitutes:** Copernicus In Situ TAC CORA `INSITU_GLO_PHY_TS_DISCRETE_MY_013_001` (DOI 10.17882/46219) or the gridded analysis `INSITU_GLO_PHY_TS_OA_MY_013_052` (0.5°, 187 levels); or NOAA NCEI World Ocean Database; or INCOIS's own in-situ portals.
   - **Bathymetry:** **GEBCO_2024** (15-arc-second global NetCDF). Attribution required: *"GEBCO Compilation Group (2024) GEBCO 2024 Grid (doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f)."*
   - **Indian EEZ boundary:** Marine Regions / VLIZ **World EEZ v12** (2023-10-25; GeoPackage/Shapefile). Attribution required.
6. **CF Conventions in practice.** Detect coordinates via `standard_name`, `units` (`degrees_north`/`degrees_east`), `axis` (X/Y/Z/T), and crucially **`positive="down"` for depth** — CF: *"if an oceanographic netCDF file encodes the depth of the surface as 0 and the depth of 1000 meters as 1000 then the axis would use attribute positive=down"*. Handle non-standard calendars via `cftime`. Use **`cf-xarray`** (the `.cf` accessor identifies latitude/longitude/vertical/time from attributes) so ingestion is name-agnostic, and run the CF checker so the compliance claim is credible.
7. **Model–observation comparison done correctly.** For each Argo/glider profile: (a) select model cells within a **spatial matchup radius** and a **time window**; (b) **interpolate the model onto observation depths** (or bin observations onto model levels); (c) **filter by QC flag**; (d) compute **bias, RMSE, MAE, correlation**, and present **Taylor diagrams** (normalised standard deviation vs correlation), standard in operational ocean-model validation against EN4/CORA/Argo.
8. **Anomaly detection — defensible, not naive.** Compute anomalies against a **climatology**, not a plain outlier detector (which conflates the seasonal cycle with anomalies). Use the **Roemmich-Gilson Argo climatology** (2004–2018 mean + monthly; 1/6° mean field, 1/2° annual cycle — note the NetCDF is **not CF-compliant**) or WOA. Express as z-scores. For heatwaves use **Hobday et al. (2016)**: *"MHWs are defined at locations where an upper locally determined threshold (90th percentile relative to the local long-term climatology) is exceeded for at least a five-day period, with no more than two below-threshold days"*, with Hobday et al. (2018) categories I–IV.
9. **Search-and-rescue drift.** Operational SAR uses **Lagrangian advection + leeway + Monte-Carlo ensembles** (Norwegian Met's **OpenDrift** `Leeway` module; the US Coast Guard's **SAROPS**). A hackathon-honest version is **surface-current advection of a particle ensemble from a last-known position with a growing uncertainty cloud**, labelled experimental. **Position it as complementary to INCOIS's SARAT**, which predicts the most probable search area for **up to 10 days**, is "based on model currents derived from very high resolution Regional Ocean Modelling System run operationally on High Performance Computers at INCOIS", and supports **60 types of missing objects** based on shape and buoyancy.
10. **Performance & scalability.** Always subset server-side: a single **500×500 grid × 50 depths float32 timestep ≈ 50 MB**; a year of daily steps for one variable ≈ **18 GB**. Tile, chunk, decimate, apply LOD, cache; keep browser 3D textures ≤256³.

---

## Part II — The Revised Specification (Build Prompt)

> Written to be handed directly to a developer or an AI coding agent. Part I above is the justification.

### 1. System overview

A **web-based, platform-independent, interactive ocean visualisation and model–observation intelligence platform** for INCOIS.

**Interaction model — two modes:**
1. **Map mode (default).** MapLibre GL JS 2D map of the Indian EEZ: surface field as raster tiles, Argo/glider markers, coastline, EEZ boundary, variable/time/depth controls.
2. **Selection.** The user drags an axis-aligned rectangle with four draggable corner handles, plus a depth-range control setting how deep the block goes.
3. **Extrude transition (~1.5 s).** The camera tilts, the footprint drops downward into a cuboid, and the water column fades in top-down.
4. **Block mode.** Full 3D Three.js scene: depth slices, ray-marched volume, GEBCO seabed mesh, Argo floats at true 3D positions with trailing profile lines, glider trajectories as curves through the water, current particles, vertical exaggeration, model-vs-observation panel.
5. **Exit.** "Back to map" reverses the animation.

**Frontend:** React/Next.js. **Backend:** Python FastAPI serving REST + PNG tiles, plus OGC WMS and OPeNDAP via xpublish plugins. **Narrative:** *Model → Observation → Comparison → Insight.* **No client-side native dependencies.**

### 2. Recommended stack

- **Frontend:** React 18 + Next.js 14 (TypeScript); **MapLibre GL JS** for map mode; **Three.js r160+** with `@react-three/fiber` + `drei` for block mode; **Plotly.js** or Observable Plot for profile charts; optional **deck.gl** for marker overlays. Share one camera model across modes so the extrude animation can interpolate between them.
- **Current particles:** custom GLSL velocity-texture layer, ported from `mapbox/webgl-wind` / `astrosat/windgl`.
- **Backend:** Python 3.11, **FastAPI**, `xarray`, **`cf-xarray`**, `zarr`, **`argopy`**, `numpy`, `scipy`, **`scikit-image`** (`marching_cubes`), **`xpublish` + `xpublish-wms` + `xpublish-opendap`**.
- **Data prep:** **`copernicusmarine`** toolbox; `kerchunk`/`virtualizarr`.
- **Deploy:** Docker Compose; static frontend build; runnable on INCOIS infrastructure.

### 3. Internal standardized data model

```ts
interface GriddedField {
  variable: string;            // canonical key: "temperature"|"salinity"|"u"|"v"|"chlorophyll"
  standardName: string;        // CF standard_name, e.g. "sea_water_potential_temperature"
  units: string;               // "degree_Celsius" | "psu" | "m s-1" | "mg m-3"
  lat: number[];               // degrees_north
  lon: number[];               // degrees_east
  depth: number[];             // metres, positive DOWN (CF positive="down")
  time: string[];              // ISO 8601 UTC
  shape: [number, number, number, number];  // [time, depth, lat, lon]
  fillValue: number;
  source: string;              // provenance, e.g. "GLORYS12V1 (CMEMS)"
}

interface ObservationProfile {
  platform: "argo" | "glider" | "ctd" | "mooring";  // extensible enum (plugin registry)
  id: string;                  // WMO id / float id / deployment id
  lat: number; lon: number;
  time: string;                // ISO 8601 UTC
  depth: number[];             // metres, positive down
  variables: {                 // arrays aligned index-for-index with depth[]
    [name: string]: { units: string; values: number[]; qc: number[] };
  };
  trajectory?: { lat: number; lon: number; time: string }[];  // gliders
  dataMode: "R" | "A" | "D";
}

interface VolumePayload {         // binary body + this JSON header
  dtype: "uint8" | "uint16";
  scale: number; offset: number;  // value = raw * scale + offset
  dims: [number, number, number]; // [depth, lat, lon]
  bbox: [number, number, number, number];
  depthRange: [number, number];
  resolution: "coarse" | "full";
}
```

Ingestion populates these for *any* CF-compliant NetCDF (via `cf-xarray`) or delimited text. **The platform enum and `variables` map are the plugin points** — adding CTD, BGC, moorings, HF-radar or ADCP needs only a new parser, no schema change.

### 4. REST API surface

All spatial endpoints are **bbox-scoped** — they serve exactly the block the user selected, nothing more.

| Method & path | Query params | Response |
|---|---|---|
| `GET /api/variables` | — | `[{variable, standardName, units, depthRange, timeRange}]` |
| `GET /api/metadata/{variable}` | — | grid axes, bbox, depth levels, timesteps, default colormap |
| `GET /api/slice` | `var,depth,time,bbox` | 2D depth-slice as JSON grid **or** PNG tile |
| `GET /api/volume` | `var,time,bbox,depthRange,res` | `VolumePayload` header + binary body; `res=coarse\|full` |
| `GET /api/isosurface` | `var,time,level,bbox` | **glTF mesh** (server-side `marching_cubes`) |
| `GET /api/bathymetry` | `bbox,res` | GEBCO-derived heightmap (Uint16 raster) for the seabed mesh |
| `GET /api/timestep` | `var,depth,bbox` | decimated all-timesteps array for animation |
| `GET /api/currents` | `depth,time,bbox` | u/v encoded **RG PNG** + min/max for the particle layer |
| `GET /api/observations` | `bbox,time,platform` | GeoJSON of profile markers |
| `GET /api/profile/{platform}/{id}` | `time` | `ObservationProfile` JSON |
| `GET /api/matchup` | `platform,id,var,radius,window` | `{obsDepths, obsValues, modelValues, bias, rmse, mae, corr}` |
| `GET /api/anomaly` | `var,depth,time,bbox` | anomaly grid vs climatology (z-score) |
| `GET /wms`, `GET /opendap` | OGC standard | mounted via xpublish plugins |
| `GET /tiles/{var}/{time}/{depth}/{z}/{x}/{y}.png` | — | XYZ raster tiles for map mode |

### 5. Re-tiered features

**MVP — maps 1:1 onto the statement's core requirements:**

1. **Map mode** — Indian EEZ 2D map, coastline, EEZ boundary, surface field tiles, observation markers.
2. **Region selection** — axis-aligned rectangle with four draggable corner handles + depth-range control.
3. **Extrude transition** — animated 2D→3D, with the loading strategy in §5.1.
4. **Block mode** — 3D lat–lon–depth cuboid with GEBCO seabed mesh.
5. **Volumetric rendering** of temperature & salinity (ray-marched 3D texture).
6. **Depth-slice views** inside the block.
7. **Isosurface extraction** (server-side marching cubes → glTF).
8. **4D time-step animation** — play/pause/prev/next/timeline/speed.
9. **Animated GPU current particles**, depth-aware.
10. **Chlorophyll as a first-class variable.**
11. **Argo floats as low-poly 3D models** at true depth positions (capsule body + antenna, built procedurally in Three.js — no external assets or licences), with a trailing profile line and a profile viewer on click.
12. **Gliders as low-poly 3D models** (torpedo body + swept wings) following their 3D trajectory curve, with profile viewer on click.
    - **Rendering:** use `InstancedMesh` so N instruments cost one draw call, not N meshes.
    - **Colour:** never random per render. Either a **stable hash of the platform ID** (so a float keeps its colour across sessions and screenshots) or, better, **colour-encoded data** — data mode (real-time / adjusted / delayed), model–observation error magnitude, or observation age. A judge will ask what the colour means; make the answer be "information", not "decoration".
13. **NetCDF ingestion** via xarray + cf-xarray (auto coordinate and `positive=down` detection).
14. **ASCII/CSV ingestion** → common observation format.
15. **Common data model with CTD/BGC support** built in (plugin registry).
16. **Variable selector.**
17. **Customizable colorbar** — palette, min/max, log/linear, opacity.
18. **Vertical exaggeration** 1×–10×.
19. **Simultaneous model + observation overlay.**
20. **Model-vs-observation comparison** (matchup + bias/RMSE) — the differentiator.
21. **Standards:** CF, OPeNDAP, OGC WMS/WCS; platform-independent, no client-side native dependencies.

**Stretch within MVP** — build only once items 1–21 are stable, and treat as optional in the demo script:
- **Basic two-point vertical cross-section** (the statement's draft rated this high-priority; the *arbitrary* transect stays Level 2).
- **Simple climatology anomaly layer** (z-score vs Roemmich-Gilson or WOA).

**Level 2 — full product:** model-accuracy maps (error/RMSE/bias) · observation-coverage map · blind-spot detection · confidence layer · data-freshness indicator · multi-variable comparison · arbitrary-quadrilateral selection · arbitrary-transect cross-section · event replay · search & navigation · data provenance · one-click report (PDF/CSV/image) · saved sessions · climatology anomaly + Hobday marine-heatwave layer.

**Level 3 — future:** natural-language query layer (§5.2) · automatic feature detection (eddies/fronts/upwelling/blooms) · eddy tracker · experimental SAR drift (complementary to SARAT) · virtual dive · exploration mode · story mode · what-if simulation · bring-your-own NetCDF · extended sensor plugins (CTD/BGC/moorings/HF-radar/ADCP).

### 5.1 Smooth-loading strategy for the 3D block

**Targets:** first pixels of the block under **400 ms**; full-resolution volume under **2.5 s**; sustained **30+ fps** while rotating and while the timeline plays. No spinner ever appears on the block itself — the extrude animation *is* the loading indicator.

**1. Prefetch before the user commits.** Fire the coarse volume and bathymetry requests as soon as the rectangle has two corners, while the user is still adjusting. Debounce at 250 ms and cancel superseded requests with `AbortController`. By the time they press "Dive", the first payload is usually already in memory.

**2. Three-stage progressive reveal, timed to the animation.**

| Stage | Arrives | Payload | What renders |
|---|---|---|---|
| 0 | immediate | bathymetry heightmap decimated to 64×64 (~16 KB) | block frame + seabed mesh + surface tile carried over from the map |
| 1 | ~300 ms | coarse volume **32×64×64** (depth×lat×lon) uint8 (**131 KB**) | water column fades in during the extrude |
| 2 | ~2 s | full volume ≤ **64×256×256** (depth×lat×lon) uint8 (**~4 MB**) | swapped in with a 200 ms cross-fade, no visible pop |

All volume dimensions are stated **depth-major**, matching `VolumePayload.dims = [depth, lat, lon]`. Keep this order end to end — a transposed volume is the classic day-three bug and looks like a rendering fault rather than an indexing one.

The extrude animation must run **at least as long as the stage-1 fetch**. If data arrives early, animation timing wins; if it arrives late, hold at the tilted state with the seabed visible rather than freezing mid-transition.

**3. Quantize and send binary.** Convert float32 to uint8 (or uint16 for high-dynamic-range fields) with `scale` and `offset` in the JSON header — 4× smaller on the wire, and WebGL normalizes it to 0–1 for free on texture upload. Send as a raw `ArrayBuffer`. **Never** `JSON.parse` a grid.

**4. Decode off the main thread.** Fetch and dequantize inside a Web Worker, then `postMessage` the buffer as a **transferable** (zero-copy) to the main thread. Parsing a 4 MB grid on the main thread is a visible frame drop mid-animation.

**5. Upload the 3D texture incrementally.** One blocking `texImage3D` on a 256³ texture stalls the GPU for several frames. Allocate the texture empty, then push one z-slab per frame with `texSubImage3D` — the volume visibly fills in from the surface downward, which reads as intentional.

**6. Adaptive ray-marching.** Drop the sample count while the camera is moving or the timeline is playing (~64 steps), refine to full quality when idle (~256 steps). This is standard progressive refinement and is the difference between smooth rotation and a slideshow.

**7. Timeline prefetch.** Keep a ring buffer of ±3 timesteps loading in the background; render the buffered range on the scrubber so playback never blocks on a fetch. Prefetch in the direction of travel.

**8. Server-side chunking and caching.** Store as Zarr chunked on `(time, depth, lat, lon)` so a bbox + depth subset is a chunk read rather than a file scan. Cache responses keyed on `(var, bbox, depthRange, time, res)`. Pre-warm the exact demo bbox and time range before judging so the demo path is always hot.

**9. Memory discipline.** Dispose GPU textures on region exit; one active block at a time; hard cap around 150 MB of texture memory. Leaked volumes across several selections will crash a laptop mid-demo.

**10. Load observations last.** Argo/glider GeoJSON is small and non-blocking — let it pop in after the block is interactive rather than gating the transition on it.

### 5.2 Natural-language query layer (Level 3)

**Why this version is worth building and a generic "AI assistant" is not.** Turning *"show temperature at 200 m"* into slider settings adds nothing — the sliders are right there, and dragging a rectangle is faster than describing one. The value is in queries the UI **cannot express at all**: *"show me the longest-travelling Argo float"*, *"which floats disagree most with the model this month"*, *"jump to the Bay of Bengal"*. These are queries over the dataset, not viewport settings. That is where natural language earns its place.

**Architecture: define the tool schema first, pick the model second.** The LLM only emits structured calls against a fixed schema, so the provider stays swappable (a free OpenRouter model now, self-hosted later) and the platform logic never depends on it.

```ts
type Tool =
  | { name: "select_region";  args: { bbox: [number,number,number,number]; depthRange: [number,number] } }
  | { name: "select_preset";  args: { region: "bay_of_bengal" | "arabian_sea" | "lakshadweep_sea" | "andaman_sea" } }
  | { name: "set_variable";   args: { variable: "temperature"|"salinity"|"u"|"v"|"chlorophyll" } }
  | { name: "set_depth";      args: { depth: number } }
  | { name: "set_time";       args: { time: string } }               // ISO 8601
  | { name: "query_floats";   args: { sortBy: "trajectory_length"|"model_error"|"recency"|"profile_count";
                                      order: "desc"|"asc"; limit: number } }
  | { name: "focus_platform"; args: { platform: "argo"|"glider"; id: string } };
```

The model returns one or more calls; the frontend executes them against the existing controls and API. **The LLM never touches the data** — `query_floats` runs server-side against the observation index, so results are computed, not generated.

**Design rules:**
- **Named presets, not random blocks.** Define fixed bboxes for Bay of Bengal, Arabian Sea, Lakshadweep Sea, Andaman Sea. *"Show me a sample of the Bay of Bengal"* resolves to a preset and then runs the exact same extrude path as manual selection — reproducible, and the demo lands identically every time.
- **Deterministic fallback required.** Ship a keyword matcher covering the six phrases you will actually demo. If conference wifi fails or the free tier rate-limits mid-pitch, the feature still works.
- **Show the resolved parameters.** Display the tool call the model produced ("region: Bay of Bengal · variable: temperature · depth: 200 m") so the user can see and correct the interpretation. Never let it act silently.
- **Free-tier caveats to state in the pitch:** free OpenRouter models generally log prompts and have tight rate limits. Fine for a hackathon; note explicitly that production would self-host, since INCOIS would not route operational queries through a third-party API. Saying this unprompted signals deployment awareness.
- **Hard line between measurement and generation.** If the layer ever explains rather than navigates (the "Ocean Detective" idea), measured values and generated interpretation must be visually separated. The scientific credibility built by the matchup metrics is easy to lose here.

### 6. Build order & critical path (3-day hackathon)

1. **Data-prep pipeline** — subset GLORYS12 (T/S/uo/vo) + Argo for one Indian-Ocean bbox to Zarr. *Start Day 1 AM — downloads are slow.*
2. **Backend skeleton** — FastAPI + xarray + `/variables`, `/metadata`, `/slice`, `/tiles`. [Day 1]
3. **Map mode + rectangle selection UI.** [Day 1]
4. **Block mode: depth-slice texture, colorbar, depth slider, seabed mesh.** [Day 1–2] — **CRITICAL PATH.**
5. **Extrude transition + staged loading (§5.1 stages 0–1).** [Day 2]
6. **Time animation + current particles.** [Day 2]
7. **3D observation markers + profile viewer + overlay.** [Day 2]
8. **Model–obs matchup endpoint + comparison panel.** [Day 3] — **DIFFERENTIATOR.**
9. **Volume ray-march + isosurface + §5.1 stage 2.** [Day 3 if time]
10. **Polish** — globe inset, adaptive ray-march, cache pre-warm, demo script. [Day 3]

**Cut first under time pressure:** volume ray-march & isosurface (fall back to stacked depth-slices, which still reads as 3D); then anomaly; then glider (if Indian-Ocean data proves scarce). **Never cut** the extrude transition or the model-vs-observation comparison.

### 7. Data acquisition checklist

- **Copernicus GLORYS12** — register at `marine.copernicus.eu` *(⚠ registration + large download; start Day 1)*:
  `copernicusmarine subset -i cmems_mod_glo_phy_my_0.083deg_P1D-m -v thetao -v so -v uo -v vo -x 60 -X 100 -y 0 -Y 25 -z 0 -Z 2000 -t 2023-01-01 -T 2023-01-31`
  *(Depth must reach 2000 m to match Argo's profiling depth — a 1000 m model subset leaves every deeper matchup with nothing to compare against. Verify the dataset ID against the live catalogue; Copernicus renames these periodically.)*
- **Chlorophyll (only if kept in the MVP)** — `copernicusmarine subset -i` the BGC reanalysis `GLOBAL_MULTIYEAR_BGC_001_029` for `chl` *(⚠ 1/4°, different grid from GLORYS12 — regrid or render separately)*; observed chlorophyll from BGC-Argo via `argopy` with `ds='bgc'`.
- **Argo** — `pip install argopy`; `DataFetcher(mode='research').region([60,100,0,25,0,2000,'2023-01-01','2023-01-31'])`.
- **Gliders** — `ftp.ifremer.fr/ifremer/glider/v2` (EGO NetCDF v1.5) *(⚠ Indian-Ocean deployments scarce — verify early)*.
- **INCOIS LAS** — OPeNDAP under `las.incois.gov.in/thredds/dodsC/las/`.
- **Bathymetry** — GEBCO_2024 NetCDF subset *(attribution required)*.
- **EEZ** — Marine Regions World EEZ v12 *(attribution required)*.
- **Climatology** — Roemmich-Gilson Argo NetCDF *(⚠ not CF-compliant)*, or `INSITU_GLO_PHY_TS_OA_MY_013_052`.

### 8. Risks

- **Transition jank** — a stutter during the extrude undoes the whole effect. Mitigate with §5.1; test on the actual demo laptop, not a dev machine.
- **Data volume / browser memory** — server-side subsetting, ≤256³ volumes, texture disposal on region exit.
- **FTP reliability** — prefer argopy / HTTP mirrors (`data-argo.ifremer.fr`) over raw FTP; cache locally.
- **Copernicus registration/download delay** — start Day 1; keep a small pre-downloaded fallback subset.
- **Glider scarcity in the Indian Ocean** — have a CTD/CORA fallback so the instrument-overlay requirement still demos.
- **"We did not build a warning system"** — explicit disclaimers on any hazard/drift feature; frame as complementary to SARAT and the INCOIS Oil Spill Trajectory System.
- **RG climatology not CF-compliant** — budget time for manual coordinate handling, or substitute WOA.

### 9. Demo script & what judges look for

**Workflow:** open the Indian EEZ map → pick a variable and time → **drag a rectangle over the Bay of Bengal** → press Dive → **the region extrudes into a 3D block** → rotate, scrub the depth slider, watch layers and the seabed → **play the 4D timeline** → click an Argo float sitting in the water column → view its temperature/salinity profile → show **model-vs-reality error** (e.g. model 24.2 °C vs observed 23.4 °C, error 0.8 °C, mapped spatially) → *(if the stretch features shipped)* toggle the anomaly / marine-heatwave highlight → back to map.

The core script above stands on its own without the anomaly step. Do not rehearse a demo that depends on a feature still marked optional the night before.

**WOW moments, in order:** (1) the extrude transition, (2) model vs reality, (3) the 4D timeline.

**Judges (INCOIS) will look for:** compliance with the stated core — genuine depth-resolved volumetric rendering, OPeNDAP/WMS/CF standards, an extensible plugin architecture; a scientifically defensible differentiator — model–observation validation with proper matchup metrics; operational relevance to disaster management that complements rather than duplicates SARAT; and polish — a smooth browser demo with no client-side dependencies, usable at exhibitions and for outreach.

---

## Caveats

- **GLORYS12V1 specifics** (1/12°, 50 levels with 22 in the top 100 m, 1993→2024) come from the Copernicus product page and Storer et al. (arXiv:2311.09100) / Lellouche et al. (2021); confirm the current end-date and level table against the live product page before citing in the submission.
- **SARAT's forecast horizon** is stated by INCOIS as up to 10 days for SARAT-2; an older 2016 report said five days. Verify at submission time.
- **`xpublish-wms` maturity:** works for regularly-spaced lat/lon grids (GLORYS qualifies) but is still maturing upstream for some grid types; keep pre-rendered TiTiler tiles as a fallback.
- **WebGL2 3D-texture limits** vary by GPU/OS/driver (spec floor 256; NVIDIA 16384; AMD 2048 Windows / 8192 Linux). Test on the actual demo hardware and design to the 256³ budget.
- **The Roemmich-Gilson climatology NetCDF is not CF-compliant** per the Scripps distribution page — `cf-xarray` will not auto-detect its coordinates.
- **Marine-heatwave categories I–IV** are Hobday et al. (2018); the 90th-percentile/5-day definition is Hobday et al. (2016). Cite both.
- Drift/validation figures describing OpenDrift performance come from regional case studies used to illustrate *method*, not to assert Indian-Ocean performance or INCOIS results.
