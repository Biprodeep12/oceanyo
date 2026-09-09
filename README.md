# Ocean Model–Observation Intelligence Platform

**SIH 26067** · Ministry of Earth Sciences / INCOIS · Software · Disaster Management

A web-based, platform-independent ocean visualisation and model–observation
intelligence platform. A 2D map of the Indian EEZ; select a region; the
footprint extrudes downward into a 3D lat–lon–depth block showing the water
column, seabed and in-situ observations in true 3D.

Full specification: [SIH26067-spec-v2-1.md](SIH26067-spec-v2-1.md).

---

## ⚠️ Data provenance — read this first

**This build runs on synthetically generated data, not real observations.**

The fields are analytic functions shaped to resemble the Bay of Bengal, written
in genuine CF-1.8 NetCDF using GLORYS12V1 variable names and conventions. The
Argo and glider files use the real Argo core-profile and EGO v1.5 formats.
Nothing here is a reanalysis, and no value in this system is a measurement of
the real ocean.

This is a deliberate architectural decision, not a shortcut. The ingestion layer
is source-agnostic, and swapping to real data is one environment variable:

```bash
OCEANUPS_CATALOG=config/catalog.glorys.yaml   # instead of catalog.synthetic.yaml
```

The two catalogs are structurally identical — they differ only in file paths and
the `synthetic` flag. The same parsers (`argo_netcdf`, `glider_ego`) read both
synthetic and real files, so no code changes on the swap.

Provenance is enforced in code, not just in prose: the `synthetic` flag flows
from the catalog YAML → `/api/health` → a persistent amber **SYNTHETIC DATA**
badge in the header, and into every dataset `source` attribute. When real data
is loaded, the badge disappears on its own.

**Why synthetic data makes the science testable.** Observations are the model
field plus a *known* injected bias (−0.30 °C, +0.05 psu). The matchup endpoint
must therefore recover that bias — and it does, to +0.3159 °C against +0.30
expected (σ = 0.011) across 87/87 profiles. That single assertion exercises the
generator, NetCDF encoding, CF adapter, colocation, vertical interpolation and
statistics together. It is not possible with real data, where the true answer is
unknown.

---

## Quick start

Requires **Python 3.12** and **Node 20+**. Python 3.13/3.14 will not work —
`xpublish-wms` depends on `cartopy` and `datashader` (→ `numba`), neither of
which publishes wheels for those versions, and pip would fall back to a source
build needing GEOS and MSVC.

```bash
# 1. Backend environment (uv shown; python -m venv works too)
uv python install 3.12
uv venv backend/.venv --python 3.12
VIRTUAL_ENV=backend/.venv uv pip install -r backend/requirements.txt

# 2. Frontend
npm install
npm --prefix web install

# 3. Generate the synthetic dataset (~12 s, ~165 MB)
npm run synth          # or: npm run synth:tiny for a fast 15 MB version

# 4. Verify the data contract
npm run verify         # 34 assertions, including the bias-recovery test

# 5. Run both servers
npm run dev            # API on :8000, web on :3000
```

Open <http://localhost:3000>.

---

## Demo path

1. Map of the Bay of Bengal, surface temperature as raster tiles, Argo and
   glider markers coloured by model–observation error.
2. **Show anomaly** recolours the map by departure from climatology, in
   standard deviations. The mesoscale eddies separate cleanly from the
   seasonal cycle, because the climatology is generated eddy-free.
3. Pick a region — **shift+drag** on the map, or a named preset — then adjust
   the four corner handles.
4. Press **Dive**. The footprint extrudes into a 3D block.
5. Orbit the block, scrub the depth slider, play the timeline.
6. Click a float in the water column → its profile, and the model-vs-observation
   comparison with bias / RMSE / MAE / correlation.
7. **Cross-section**, then click two points on the sea surface, hangs a
   vertical curtain through the block: mixed layer, thermocline and the cut
   against the seabed.
8. **Back to map** reverses it.

---

## Architecture

```
config/catalog.*.yaml     the swap surface: synthetic <-> real, same schema
backend/app/core/         the seam. conventions.py is written by the generator
                          AND read by the CF adapter, which is what makes the
                          swap a config change rather than a rewrite
backend/app/api/          FastAPI: 21 endpoints, parser registry, services
backend/app/pipeline/     synthetic generator + contract verification
web/src/                  Next.js: MapLibre map mode, react-three-fiber block
web/src/components/shell/ the floating UI: layers panel, rail, timeline, legend
```

See [FEATURES.md](FEATURES.md) for what the thing actually does.

### Interface

The map is the page: a full-bleed canvas with translucent panels floating on
top, in the shape a weather map conventionally takes — logo and layer list on
the left, an icon rail on the right, time at the bottom centre, colour scale
and coordinates along the bottom edge. The design language is nine CSS
variables and four primitives in `globals.css`, so a change moves the whole UI
at once rather than being retyped per component.

Three consequences worth stating:

- **Menu rows wrap real radios and checkboxes.** The visual is ours; the
  semantics, keyboard behaviour and accessible name are the browser's. That is
  also what lets the smoke test address them by label instead of by pixel.
- **The pointer readout samples locally.** One decimated grid per (variable,
  depth, time) is fetched and bilinearly sampled, so a value follows the cursor
  with no request per mouse move.
- **The hidden renderer is made inert with a class, not an inline style.**
  `pointer-events: none` on a wrapper is not enough: both the r3f canvas
  container and the MapLibre canvas container set `pointer-events: auto` on
  themselves and win. The invisible 3D canvas therefore sat on top of the map
  and swallowed every mouse event -- panning, scroll zoom, shift+drag region
  selection and the corner handles were all dead, and nothing looked wrong
  because the canvas is transparent and the demo path used preset buttons. A
  shift+drag step in the smoke test now guards it.

### Responsive

The layout is built for a phone as well as a desktop, and the smoke test drives
both.

- Panels become **sheets** below 768px: near-opaque, dismissable, with a scrim.
  The layer list moves behind a rail button; the profile panel anchors to the
  top so it never covers the time bar that controls what it is showing.
- **Tap-to-draw regions.** Shift+drag cannot exist on a touch screen -- there is
  no shift, and a drag is a pan. `Draw region` takes two taps on opposite
  corners, and it is offered on every device rather than being a mobile
  fallback. Without it the 3D block is unreachable on a phone.
- **A tap probes the field**, since a touch screen never hovers.
- The block camera is **fitted to the viewport**, not to a fixed position: a
  tall screen has a narrow horizontal field of view, and the framing that suits
  a desktop crops the block on a phone.
- Hints name the gesture the reader actually has -- "pinch to zoom", not
  "scroll to zoom".

### Decisions worth knowing

- **No CORS anywhere.** Next rewrites proxy `/api`, `/tiles`, `/wms` and
  `/opendap` to the API process, so every request is same-origin. Binary
  responses need no preflight and `AbortController` behaves identically in dev
  and production.
- **Volume wire format** is one length-prefixed body:
  `[uint32 LE headerLen][utf8 JSON header][raw bytes]`. One round trip, and the
  Web Worker parses the header without a second fetch.
- **Raw 0 is reserved for fill.** WebGL normalises uint8 to 0–1 on upload, so
  the shader discards `texel == 0.0` as land/seabed with no mask texture.
  Without this, land renders as ice-cold water.
- **vmin/vmax are dataset-wide, never per-request.** Otherwise the colour
  mapping shifts whenever the depth slider or timeline moves, and the volume
  appears to flicker between frames.
- **Dimensions are `[depth, lat, lon]` end to end.** A transposed volume looks
  like a rendering fault rather than an indexing one, so the order is settled
  once in `CFDataset.select()` and asserted again in the encoder and the worker.
- **Binary data and GPU handles are never in React state.** A re-render that
  drops a texture reference without disposing it leaks GPU memory and crashes a
  laptop a few selections later.
- **The depth axis is stretched, not linear, and *everything* uses it.** The
  model resolves the upper ocean far more finely than the abyss, so block
  geometry uses normalised layer index and the axis is labelled from the real
  depth table — as ocean profile plots conventionally are. The volume, the
  isosurface, the seabed mesh, the floats, the glider tracks and the section
  curtain all go through the single `depthToY` mapping, and the isosurface is
  extracted at the same level-of-detail as the volume on screen so their level
  tables match. Mixing index space with linear depth is not a cosmetic error:
  it put 1000 m floats at mid-block when that water was near the bottom, and
  drew shelf seabed near the surface with rendered water beneath it.
- **No remote basemap, and the coastline comes from our own bathymetry.** A
  remote style that stalls leaves MapLibre permanently unloaded, and it then
  refuses to render *any* vector layer -- the selection rectangle and the
  instrument markers vanish while raster tiles keep working. Land is traced
  from the same elevation field the seabed mesh uses, so the map has zero
  network dependencies beyond our own API and the coastline agrees with the
  block by construction. With the synthetic catalog it is a synthetic
  coastline, and the API response says so.
- **The climatology is interpolated onto the model grid, not required to match
  it.** The synthetic pair happens to share axes, which would have made a shape
  check pass forever — but every real climatology is coarser than the model it
  is compared against (WOA 1/4°, Roemmich–Gilson 1°, GLORYS 1/12°), so that
  check would have failed on the first real swap.
- **`xpublish` is mounted on a background thread inside try/except.** Importing
  `xpublish-wms` measured 30–70 s on this machine, and it is the least mature
  dependency in the stack. The API boots in ~2 s regardless; `/api/health`
  reports what actually came up.
- **Observation profiles are cached and pre-warmed behind the API.** Each
  profile is a NetCDF open, and the matchup summary that colours the instrument
  markers walks a few hundred of them. Cold that endpoint took 9.4 s and landed
  on the demo path; cached it is 0.37 s, and a background pre-warm at startup
  means even the first call is warm.

---

---

## Datasets

Every source named in the problem statement, what was actually reachable, and
what it changed.

| # | Source | Reachable without an account | Status |
|---|---|---|---|
| a | Copernicus **GLORYS12V1** | no (free registration) | `catalog.glorys.yaml` carries the dataset IDs and the exact `copernicusmarine subset` commands |
| a | **INCOIS LAS** | catalog yes, data no | `las.incois.gov.in/thredds/catalog.xml` responds in 0.2 s; the `dodsC` OPeNDAP endpoints for its Ferret `.jnl` datasets time out at 45 s. Data is obtainable through the LAS UI subset flow, not by anonymous OPeNDAP |
| b | **Argo GDAC** | **yes** | **Fetched and parsed.** 4 INCOIS-DAC floats, 800 profiles, 0 failures |
| c | **EGO glider GDAC** | **yes** | **Fetched and parsed.** 1 deployment, 192 dives/climbs, 0 failures |
| d | Collection of in-situ data | **yes**, via substitute | **Fetched and used.** The statement's link is missing; **NOAA WOA23** is the World Ocean Database objectively analysed onto a grid and needs no account. Copernicus CORA `INSITU_GLO_PHY_TS_DISCRETE_MY_013_001` (DOI 10.17882/46219) is the like-for-like product but needs registration |

```bash
npm run fetch:real            # Argo + one glider deployment, no credentials
npm run fetch:real -- --woa   # and WOA23 -> a real 0.4 MB climatology (~160 MB down)
```

### A real climatology, from real in-situ data

WOA23 ships `t_an` (objectively analysed mean) and `t_sd` (standard deviation)
-- exactly what the anomaly service wants, so converting it is a rename and a
subset, not a computation. `fetch_real.build_woa_climatology` writes
`<raw>_mean` / `<raw>_std` in the same shape the synthetic writer produces, and
the anomaly endpoint consumes it with **no code change**:

```
model grid : 137 lat x 121 lon x  40 levels
WOA23 grid :  17 lat x  15 lon x 102 levels
    0 m  coverage 61%  z -1.55.. 2.42
  100 m  coverage 60%  z -1.41.. 2.98
```

This is the payoff from a change made blind: the anomaly service interpolates
the climatology onto the model grid rather than requiring the two to match,
because every real climatology is coarser than the model it is compared
against. A 1-degree WOA against a 1/8-degree model is that case, and a shape
check would have refused it.

Stated plainly: those z-scores are only *meaningful* once the model is real
too. Against the synthetic model the deep values run to tens of sigma, because
a made-up ocean and the real World Ocean Database disagree at depth -- as they
should. The machinery is proven; the numbers wait on real GLORYS12.

### What to take from each

**Copernicus GLORYS12V1** — three of the datasets on the product page matter:

| Dataset ID | Why |
|---|---|
| `cmems_mod_glo_phy_my_0.083deg_P1D-m` | **The one to get.** Daily matches Argo's 10-day cycling closely enough for a 24 h matchup window; monthly does not |
| `cmems_mod_glo_phy_my_0.083deg-climatology_P1M-m` | Month-of-year climatology — drives the anomaly layer without inventing one |
| `cmems_mod_glo_phy_my_0.083deg_static` (`bathy`) | Bathymetry on the model's own grid, so the seabed mesh and the volume mask agree by construction rather than by regridding GEBCO |

Skip the monthly mean unless you want a multi-year run, and skip `coords` and
`mdt`. **Depth must reach 2000 m** or every Argo matchup below the subset floor
has nothing to compare against.

**INCOIS LAS** — of the products in its catalogue, four are in scope:

| Product | Why |
|---|---|
| **INCOIS Global Ocean Reanalysis (IGORA)** | The most relevant model output: Indian-Ocean reanalysis from the problem owner |
| **ARGO DATA PRODUCTS** | Gridded/objectively-analysed Argo — a ready answer to (d) |
| **NEW GLOBAL CLIMATOLOGY (NIO)** | North Indian Ocean climatology for the anomaly layer |
| **OCEAN COLOUR PRODUCTS** | Observed chlorophyll; GLORYS12 is physics-only and carries none |

GODAS is a reasonable fallback for IGORA. Tropflux, ASCAT/OSCAT/QuikSCAT winds,
MaMetAtTIO, microwave and carbonate products are out of scope for this platform.

### What fetching real data actually changed

The claim this project rests on is that a real swap is a config change. It was
not, and finding out cost three defects -- all of them invisible while both
sides of the pipeline were generated here.

**1. Real GDAC files are NetCDF-3 classic.** `h5netcdf` cannot open them at
all; it reports "file signature not found", which reads like a corrupt
download. The engine is now sniffed from the file's magic bytes
(`core/netcdf.py`) and the catalog no longer forces one.

**2. Real Argo QC flags are characters, not integers.** xarray returns an
object array mixing `bytes` with `nan` where the flag is blank, and
`.astype(int)` on that took out **762 of 840 profiles**. `obs/qc.py` decodes
every encoding and maps blank to 0 -- "no QC performed" -- rather than to 1,
which would have promoted unchecked levels into the quantitative statistics.
The generator now writes character QC too, so both sides exercise one path.

**3. Real EGO glider files are not profiles at all.** They are a single
time series -- 66,000 samples for a two-week deployment -- with a `PHASE`
variable marking descent and ascent (EGO reference table 9). The parser would
have read an entire deployment as *one* profile diving to 1000 m and back. It
now cuts dives and climbs at the PHASE inflexions, and still reads the
profile-shaped variant the generator writes.

Two more things worth knowing about this data:

- **The EGO trajectory index lies about position.** Two deployments advertise
  transposed coordinates: one claims 10 N 78 E (the Bay of Bengal) and is
  actually off **Svalbard**; another claims the Somali coast and is in the
  **Mediterranean**. `fetch_real.py` confirms every candidate by reading the
  file and discards the ones that do not match.
- **There are no Bay of Bengal glider deployments in the GDAC.** 131 of 1115
  fall in the wider Indian Ocean, almost all in the Mozambique Channel. The
  spec warned coverage was sparse; that is the number. The demo therefore
  keeps synthetic gliders in the Bay of Bengal and uses a real deployment as
  the format fixture.
- **Real-time data contains samples flagged good at 40 degrees C.** Real-time
  mode applies almost no QC, and one such spike moves RMSE more than every
  genuine difference in a profile combined. The matchup now applies a
  gross-range check against the variable's valid range -- the first test in
  any operational QC suite, and the reason delayed mode exists.

## Standards compliance

| Standard | Endpoint | Status |
|---|---|---|
| CF-1.8 | dataset attributes | `positive="down"` on depth; `cf-xarray` resolves all four axes name-agnostically |
| OGC WMS | `/wms?service=WMS&version=1.3.0&request=GetCapabilities` | advertises `thetao`, `so`, `uo`, `vo` |
| OGC WMS | `/wms?...request=GetMap` | use `crs=EPSG:3857`, or `EPSG:4326` in lon,lat order |
| OPeNDAP | `/opendap.dds` | full DAP dataset descriptor |

Both are served by `xpublish` directly from the CF-compliant xarray dataset.

---

## Plugin architecture

`GET /api/platforms` lists every registered observation parser and what it
supplies. Adding a platform means adding one file — no schema, endpoint or
frontend change:

```python
@REGISTRY.register
class MyParser:
    parser_id = "my_source"
    platform = "mooring"
    def capabilities(self) -> ParserCapabilities: ...
    def discover(self, root, bbox, t0, t1) -> list[ProfileRef]: ...
    def load(self, ref) -> ObservationProfile: ...
```

Three ship today: `argo_netcdf`, `glider_ego`, `ctd_csv` (which also satisfies
the ASCII/CSV ingestion requirement).

---

## Attributions and required disclaimers

- **This platform is not a warning system.** It is a co-visualisation and
  validation layer. Any drift or hazard feature is experimental and
  complementary to INCOIS's operational **SARAT** and Oil Spill Trajectory
  System — never a replacement for them.
- **Bathymetry is synthetic**, shaped to resemble a GEBCO tile. Real deployment
  requires GEBCO_2024 with its attribution: *"GEBCO Compilation Group (2024)
  GEBCO 2024 Grid (doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f)."*
- **No EEZ boundary is drawn.** Rather than approximate an official maritime
  boundary, the map shows the data extent. A real deployment should use Marine
  Regions / VLIZ **World EEZ v12**, with its required attribution.
- **Real model data** would be Copernicus **GLORYS12V1**
  (`GLOBAL_MULTIYEAR_PHY_001_030`, DOI 10.48670/moi-00021); real observations
  from the **Argo GDAC** and the **EGO/OceanGliders** GDAC. Acquisition commands
  are in spec §7.
- Basemap © OpenStreetMap contributors, via MapLibre demo tiles.

---

## Verification

```bash
npm run verify           # data contract: 40 assertions
npm run fetch:real       # download real Argo + glider data and parse it
node web/scripts/smoke.mjs   # browser smoke test: 21 desktop + 5 mobile steps
```

The smoke test drives the real demo path in Chromium and fails on any console
error: load, catalog, map render, pointer readout, shift+drag selection,
region presets, Dive, block render, click a float, matchup statistics,
isosurface, current particles, colorbar, anomaly layer, glider tracks,
cross-section, back to map. It is what caught the MapLibre worker failure, the
CSS position collision, the tile-template encoding bug, a conditional-hook
regression and the dead-map pointer-events bug -- none of which a typecheck or
an API test can see.

Screenshots are captured with a long timeout and their elapsed time is printed:
this runs on SwiftShader, where a full-viewport ray-march takes seconds per
frame, and a slow software renderer must not read as a failure while a genuine
hang still does.

Covers CF axis detection and `positive="down"`, monotonic axes, variable
resolution by `standard_name`, depth coverage to 2000 m for Argo matchups, the
`(depth, lat, lon)` orientation contract, seabed masking, quantization round-trip
within one quantum, fill mapping to reserved raw 0, parser discovery, the
assertion that no instrument samples below the seafloor, section sampling
checked against the gridded field at the same coordinates, climatology
interpolation producing structured (not flat, not all-NaN) anomalies, and the
end-to-end bias-recovery test.

The same suite runs against whichever catalog is configured, so it is also the
gate for a real-data swap.

### Feature status against spec section 5

All 21 MVP items are built, and the browser smoke test exercises each of them:

1-4. Map mode over the Indian EEZ, axis-aligned rectangle selection with four
draggable corner handles, animated 2D-to-3D transition, and block mode with a
GEBCO-shaped seabed mesh.

5-9. Ray-marched volume rendering, an in-block depth plane, server-side
isosurface extraction (marching cubes returned as glTF), the 4D timeline, and
the depth-aware GPU current-particle layer.

10-15. Chlorophyll as a first-class variable on its own BGC grid, Argo floats as
instanced 3D bodies at their parking depth, gliders with distinct
torpedo-and-wing geometry following their sawtooth flight path, CF NetCDF
ingestion, CSV ingestion, and the parser registry.

16-21. Variable selector, customizable colorbar (palette, min/max, log/linear --
driving the map tiles and the volume shader from one setting), 1x-10x vertical
exaggeration, simultaneous model + observation overlay, model-vs-observation
matchup, and the CF / WMS / OPeNDAP standards surface.

Both "stretch within MVP" items are also built:

- **Climatology anomaly layer.** `/tiles/anomaly/...` renders the z-score
  against the eddy-free climatology on a diverging scale centred at zero, with
  a configurable sigma limit. Because the synthetic climatology is generated
  with mesoscale features switched off, the layer isolates the eddies from the
  seasonal cycle -- which is exactly the distinction between a defensible
  anomaly and a naive outlier detector.
- **Two-point vertical cross-section.** Click two points on the sea surface and
  `/api/section` returns the curtain between them, sampled at the model's own
  levels and hung inside the block. The image rows *are* the model levels, so
  the curtain shares the vertical axis with the volume and lands inside it by
  construction rather than by tuning.

Reduced fidelity, stated plainly: the extrude is a camera and opacity crossfade
rather than the pixel-registered map-to-block hand-off; the current layer's
playback is time-compressed (direction and relative speed are the model's, the
rate is not, and the UI says so); and the section track is a straight line in
longitude/latitude rather than a great circle, which over a selection-sized
span is smaller than the grid spacing (reported distances are still true
great-circle kilometres).
