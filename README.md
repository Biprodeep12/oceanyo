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
npm run verify         # 40 assertions, including the bias-recovery test

# 5. Run both servers
npm run dev            # API on :8000, web on :3000
```

Open <http://127.0.0.1:3000>.

### Or run it on real data, with no account anywhere

```bash
npm run fetch:hycom    # 1/12 deg model: HYCOM GOFS 3.1 (public domain)
npm run fetch:erddap   # chlorophyll (VIIRS) + bathymetry (ETOPO 2022)
npm run fetch:real     # Argo floats + an EGO glider deployment
npm run fetch:real -- --woa   # WOA23 climatology

OCEANUPS_CATALOG=config/catalog.hycom.yaml npm run dev
```

That environment variable is the entire migration. See
[Real data, end to end](#real-data-end-to-end).

### Docker

```bash
docker compose up --build     # http://localhost:3000
```

`data/` is bind-mounted read-only rather than baked into the image: the
dataset is bigger than the code by two orders of magnitude, and regenerating
it should not be a rebuild. Generate it on the host first with the commands
above. *Authored and reviewed, but not run — there is no Docker daemon on the
development machine, so treat the compose file as unverified.*

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

## Running the demo

`npm run rehearse` walks the section 9 narrative in order, in one session, with
no reload, and reports time per beat. The last run:

```
   483 ms  open the map
  2301 ms  basemap and field tiles painted
   396 ms  pick a variable, a region and a time -- Bay of Bengal, 2023-10-15, 3 instruments
  1546 ms  WOW 1: press Dive -- left map mode in 3 ms
     2 ms  water column resolves -- 0.0 s from pressing Dive
  5743 ms  orbit the block -- 18 fps (CPU renderer; a floor, not the demo machine)
  1026 ms  scrub the depth slider through the thermocline
  6166 ms  WOW 3: play the timeline -- 9 of 12 steps in 4 s, 11 buffered
   644 ms  click an Argo float -- argo 1902669:3, 102 levels matched
   114 ms  WOW 2: model vs observation -- bias -0.055, RMSE 0.369 over 102 levels
  1931 ms  back to map -- selection kept

  14 beats, 0 broken, 21.7 s end to end, 0 console errors
```

**Three things a presenter has to know**, all found by that rehearsal and none
of them visible to a feature test:

- **Region and time are not independent.** Only three or four floats are
  contemporaneous with any given month, so a region and a month have to be
  chosen *together*. **Bay of Bengal at 2023-10** has three; `central_bob` at
  the same step has three; `sri_lanka_east` at 2024-06 has one.
- **`andaman_sea` has no observation at any time in this catalogue.** Selecting
  it can never reach the matchup panel. It is a real region with real model
  data and no floats — worth showing deliberately as a blind spot, never by
  accident on the way to WOW moment 2.
- **Playing the timeline moves you off the float.** Section 9 plays the
  timeline and *then* clicks a float, but playback stops wherever it stops, and
  that is usually a month with nothing to click. Pause and step back before
  clicking. The UI says so — the layers panel reads "0 of 992 within 16 days of
  this step" — but on stage nobody is reading it.

None of this is a defect. It is what a monthly model and a sparse float record
do when you put them in the same view, and the platform reports it correctly
throughout. It is only a hazard for someone who has not rehearsed.

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

## Real data, end to end

The headline claim of this project is that swapping synthetic data for real
data is a config change. That is only worth saying if someone can run it, so
there is a second catalog in which **every layer is real and nothing needs an
account**:

```bash
OCEANUPS_CATALOG=config/catalog.hycom.yaml npm run dev
```

| Layer | Source | Grid | Account |
|---|---|---|---|
| **Model** T/S/U/V | **HYCOM GOFS 3.1** `GLBy0.08/expt_93.0` | 1/12°, 40 levels to 5000 m | none |
| **Chlorophyll** | **VIIRS** SNPP + NOAA-20, DINEOF gap-filled (NOAA ERDDAP) | ~1/12°, surface, daily | none |
| **Bathymetry** | **ETOPO 2022** (NOAA NCEI, ERDDAP) | 30 arc-second | none |
| **Climatology** | **NOAA WOA23** | 1° | none |
| **Observations** | **Argo** + **EGO gliders** (Ifremer GDACs) | profiles | none |

### Why HYCOM rather than GLORYS12

GLORYS12 is the product the problem statement names, and `catalog.glorys.yaml`
carries its dataset IDs and exact `copernicusmarine subset` commands. But it is
behind a free *registration*, and a credentialed download cannot be part of an
offline demo or of a grader running `git clone`. HYCOM + NCODA GOFS 3.1 is the
same class of product — 1/12°, eddy-resolving, 40 levels, daily — in the public
domain, served over anonymous HTTPS by THREDDS NetcdfSubset.

It is also a **stricter** test of this codebase, for two reasons:

**It shares none of our names.** GLORYS calls temperature `thetao` — which is
what the synthetic generator writes, because it was built to GLORYS's shape. A
GLORYS swap would therefore never exercise name resolution at all; the two
sides agree by construction. HYCOM calls it `water_temp` and declares
`standard_name = sea_water_temperature`. It resolves through the CF path in
`core/conventions.py` with an **empty `variables:` map** in the catalog. That is
the entire ingestion claim, finally under test against a source that disagrees.

**Its temperature is the right one.** HYCOM `water_temp` is in-situ; Argo `TEMP`
is in-situ. That pairing is physically correct. GLORYS `thetao` is *potential*
temperature, and comparing it to Argo TEMP carries a small systematic offset
that grows with depth — a subtlety worth knowing before quoting a bias.

### What real model data changed

**The catalog's bathymetry escape hatch did not work.** `catalog.glorys.yaml`
has carried `bathymetry.variable: elevation` since the first commit, but the
router read `ds["elevation"]` directly and ignored it. GEBCO calls that field
`elevation`; ETOPO 2022 calls it `z`. The declared swap surface was decoration.
It now resolves catalog → CF `standard_name` → the names these products
actually use → the sole variable if the file has only one.

**ERDDAP serves NetCDF-3 classic**, exactly like the Argo GDAC, so the engine
sniffer added for Argo earned its keep a second time on a completely unrelated
source. `h5netcdf` reports "file signature not found", which reads like a
corrupt download.

**The matchup window was reported but never enforced.** `MatchupResult`
carried `windowHours` from the first commit and the colocation code never
applied it: `CFDataset.select` snaps to the *nearest* model timestep, so an
Argo profile from **2002** was being compared against a **January 2024**
analysis and reporting a confident sub-degree bias. Nothing synthetic could
show this — the generator samples its floats from the model's own timesteps,
so every profile is in window by construction. Real floats outlive real model
subsets. Enforcing the window cut 259 "matchups" to the **5 that are real**,
and the statistics improved as a result:

| | profiles | mean bias | mean RMSE |
|---|---|---|---|
| nearest-step (wrong) | 259 | −0.320 °C | 1.02 °C |
| **±36 h enforced** | **5** | **−0.002 °C** | **0.65 °C** |

Near-zero bias with sub-degree RMSE against real Argo is what a good
operational analysis looks like. The earlier number was worse *because* it was
comparing across twenty years.

**Real Argo reports pressures no float can reach.** Float 2900226 logs
**6552 dbar in 4100 m of water** — beyond even Deep Argo's 6000 m, and deeper
than the Bay of Bengal. Its good data stops at a 985 dbar parking depth; the
deep levels are flagged `PRES_QC = 4` or carry no flag at all. The parser now
applies the two standard tests to *pressure* specifically — QC 3/4/9 dropped,
range limited to [−5, 6000] dbar — because a bad pressure is not like a bad
temperature: a sample that cannot be placed in the water column renders at the
wrong height and interpolates against the wrong model level. Blank QC is
**kept**, or most of the 2002–2008 record would go with it.

**A profile is not "below the seabed" because a grid says so.** Comparing real
float depths against real 30-arc-second bathymetry flagged good profiles: the
contract used one nearest cell, which cannot answer the question on a
continental slope where the seabed drops a kilometre in two cells. It now takes
the deepest water within 0.1°, and allows 2% — because profile "depth" here is
pressure in decibars, and reading dbar as metres overstates depth by 1–2% at
2000 m. The last offender overshot by 11 m on 2121 m.

**The climatology was keyed on the model's variable names.** WOA23 stores
`thetao_mean`; HYCOM calls the field it is compared against `water_temp`. The
anomaly layer reported that *no* variable had a climatology. The climatology is
a different product by a different producer and is now resolved on its own
terms — canonical name, then the model's name, then CF `standard_name`.

**The public server has a ~300 s response budget**, and the total work is
(timesteps × variables), not bytes. Thirty daily steps of four 3D variables at
1/12° is a couple of hours of its time however it is sliced, and every request
that overruns is closed with *"Remote end closed connection without response"* —
a message that reads like a network fault and is really a timeout. The fetcher
samples every third day instead: same month, same resolution, same variables,
and still within a couple of days of every Argo profile in the window. The
timeline loses smoothness; the science loses nothing.

---

## Datasets

Every source named in the problem statement, what was actually reachable, and
what it changed.

| # | Source | Reachable without an account | Status |
|---|---|---|---|
| a | **HYCOM GOFS 3.1** (substitute for GLORYS12) | **yes** | **Fetched and used.** 1/12°, 40 levels, public domain — see [Real data, end to end](#real-data-end-to-end) |
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

### The basemap is ours too

Land is **Natural Earth II** (public domain), bundled in `web/public/basemap`
as 341 Web Mercator tiles, 3.4 MB. Still no remote basemap: a remote source
leaves MapLibre's style permanently "not loaded" if it stalls, and it then
refuses to render *any* vector layer -- the selection rectangle and the
instrument markers vanish while raster tiles keep working.

It exists because a regional subset without land is an unexplained void that
reads as a broken renderer rather than as "no data here". That was the first
thing a real user said about it.

`scripts/build_basemap.py` reprojects a **geodetic TMS** pyramid (2^(z+1) x 2^z
tiles, y from the south -- what Cesium wants) into **Web Mercator XYZ** (2^z x
2^z, y from the north -- what MapLibre wants). Serving the former as the latter
is wrong in two independent ways at once: latitudes compressed by the missing
Mercator stretch, and the image mirrored top to bottom. The result looks like a
half-broken alignment rather than a projection error, which is exactly why it
is worth a script instead of a shrug.

## Standards compliance

| Standard | Endpoint | Status |
|---|---|---|
| CF-1.8 | dataset attributes | `positive="down"` on depth; `cf-xarray` resolves all four axes name-agnostically |
| OGC WMS | `/wms?service=WMS&version=1.3.0&request=GetCapabilities` | advertises `thetao`, `so`, `uo`, `vo` |
| OGC WMS | `/wms?...request=GetMap` | use `crs=EPSG:3857`, or `EPSG:4326` in lon,lat order |
| OPeNDAP | `/opendap.dds` | full DAP dataset descriptor |
| OGC WCS | `/wcs?service=WCS&version=2.0.1&request=GetCapabilities` | 2.0.1 **core profile**, KVP |
| OGC WCS | `/wcs?...request=GetCoverage&coverageId=temperature&subset=Lat(10,18)&subset=Long(85,92)&subset=depth(0,200)` | CF-1.8 NetCDF, trimmed |

WMS and OPeNDAP are served by `xpublish` directly from the CF-compliant xarray
dataset. **WCS is ours** — no xpublish plugin serves coverages, and the problem
statement names WMS/WCS together.

The WCS scope is stated rather than implied: GetCapabilities, DescribeCoverage
and GetCoverage with trimming subsets, in the coverage's native CRS84. There is
no scaling, interpolation, range-subsetting or reprojection extension.
Advertising those in a capabilities document and then failing on them is worse
than not advertising them, because a client believes what it is told. What it
does do is return the same array the REST API returns, through the same
`CFDataset` orientation contract, so the two cannot disagree:

```bash
curl -s "http://127.0.0.1:8000/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=temperature&subset=Lat(10,18)&subset=Long(85,92)&subset=depth(0,200)"   -o coverage.nc     # 27x65x57, opens in xarray, cf-xarray finds every axis
```

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

### The CF claim, checkable rather than asserted

```bash
docker compose run --rm api   python -m cfchecker.cfchecks -v 1.8 /app/data/real/hycom_indian_ocean.nc
```

`cfchecker` depends on `cfunits`, which needs UNIDATA's native **UDUNITS-2**.
There is no Windows wheel for it outside conda, so it is deliberately **not** in
`backend/requirements.txt` -- putting it there would break `pip install -r` on
the development platform for a tool that audits output rather than running the
app. It lives in `backend/requirements-cf.txt`, and the Docker image installs
`libudunits2-0` alongside it so the check runs in the environment that ships.

Stating that plainly matters more than a pasted transcript: the compliance
claim is worth exactly as much as the reader's ability to re-run it, and
"we ran it once on a machine you do not have" is not that. What *does* run
everywhere is `npm run verify`, which asserts the same properties the checker
looks at -- `positive="down"`, monotonic ascending axes, resolvable
`standard_name`s, parseable time -- against whichever catalog is configured.


```bash
npm run verify           # data contract: 40 assertions
npm run fetch:real       # download real Argo + glider data and parse it
npm run smoke            # browser smoke test: 21 desktop + 5 mobile steps
```

**Run the smoke test against a production build**, not `next dev`:

```bash
npm --prefix web run build && (cd web && npx next start -p 3000)
npm run smoke
```

The dev server is not a reliable test target here. Turbopack's watcher can peg
a core and stop answering on :3000 partway through a run, and the page then
looks broken in a way that has nothing to do with the page: blank map, empty
layer list, no error. A production build has no watcher, no HMR and no
recompilation, so a failure in it is a real failure — and it is what the demo
actually runs. Two rules that follow: the test asks for **127.0.0.1**, not
localhost (see the note in `smoke.mjs`), and **do not edit source while a run
is in flight** — Fast Refresh remounts MapLibre mid-test and every step after
that fails with `Style is not done loading`.

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

All 21 MVP items are built, both "stretch within MVP" items are built, and
thirteen of the fourteen Level 2 features are built.

Three browser passes cover them, and they answer different questions:

| | asks |
|---|---|
| `npm run smoke` | does every feature work? |
| `npm run smoke:level2` | do the Level 2 surfaces work? (~1 min, 20 checks) |
| `npm run rehearse` | does the section 9 demo *hold together*? |

The third is the one that is easy to skip and shouldn't be. The first two are
free to reload, re-enter the block and reopen panels to isolate a feature; an
evaluator watching the demo gets none of that. `rehearse.mjs` walks the section
9 narrative in order, in one continuous session, with no reload, and reports
**time per beat** against the targets section 5.1 commits to rather than
pass/fail. It prints its own caveat: headless Chromium renders through
SwiftShader on the CPU, so its frame rates are a floor rather than a
measurement of the demo machine, while fetch, decode and API timings are
hardware-independent and can be read at face value.

The MVP items:

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
matchup, and the CF / OPeNDAP / OGC **WMS and WCS** standards surface.

Beyond the numbered list, three things the spec argues for in Part I are also
built:

- **Taylor diagram** (Part I C.7). The matchup panel plots normalised standard
  deviation, correlation and centred RMSE as one point against a reference,
  which is how operational ocean-model validation is actually reported. The
  three statistics were already computed server-side; the geometry that ties
  them together is what makes the figure readable at a glance.
- **Locator inset** (Part I B). Choosing a flat map over a globe costs the
  "where on Earth am I" glance, and the spec asks for it back cheaply. The
  inset is drawn from the same coastline the map uses -- traced from this
  project's own bathymetry -- so it cannot stall on a third-party tile server
  and cannot disagree with the map beside it.
- **Incremental 3D-texture upload** (5.1 item 5). A full-resolution volume is
  4 MB, and `texImage3D` hands the driver all of it in one call that blocks
  until it lands -- during the extrude, the one moment where a dropped frame is
  the whole point of the feature. The texture is now allocated empty and filled
  one z-slab per frame. The half-filled state needs no masking: raw 0 is
  reserved for fill, so the shader already discards un-uploaded voxels as land
  and the water column grows downward from the surface, which reads as loading
  rather than as corruption.
- **Timeline ring buffer** (5.1 item 7). Neighbouring timesteps are prefetched
  in the direction of travel, one at a time and only after the current step has
  rendered, and the scrubber shows what is buffered. Firing them in parallel
  would put six requests in front of the frame the user is waiting for.

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

### Level 2

Fourteen features are listed at Level 2. Thirteen are built; the fourteenth is
built as far as the data allows and says so in its own response.

**Five of them are one computation.** Observation coverage, blind-spot
detection, model-accuracy maps, the confidence layer and the data-freshness
indicator are the same gridded pass over the observation index seen from
different angles, so `/api/coverage` returns one GeoJSON grid carrying every
property and the client styles it six ways. Splitting them into five endpoints
would have walked the index five times and let the layers disagree about which
cell a float falls in.

Three judgements inside that endpoint are worth stating, because each is a
place where the obvious implementation is wrong:

- **Freshness is measured against the newest data in the catalogue, not against
  today.** A reanalysis that ends in 2024 is complete, not two years stale, and
  dating it against the wall clock would paint the whole map red. Nor against
  the model's last step alone: the Argo record runs *ahead* of the model here,
  which produced negative ages.
- **A blind spot is ocean with nothing in it, not merely an empty cell.** The
  bathymetry is already open, so masking land and shelf is free. Without it,
  199 of 216 cells over the Indian Ocean were "unobserved ocean", most of them
  India.
- **Confidence is evidence times agreement, and both are measured.** Agreement
  scales the RMSE by how much the field varies *between places at the same
  depth*, computed in depth bands. Pooling the whole water column into one
  sigma gives 9.5 °C for temperature -- almost all of it the surface-to-abyss
  gradient, which no model is being asked to guess -- and against that every
  cell looks certain.

The rest:

- **Multi-variable comparison** is a T–S diagram in the profile panel, coloured
  by depth. Two profiles side by side would satisfy the words and teach
  nothing: temperature and salinity are read together because a water mass is
  defined by the pair, and only a T–S plot shows it. A Bay of Bengal float
  draws its own signature -- a near-vertical fresh limb from the
  Ganges–Brahmaputra plume bending into saltier Arabian Sea water below.
- **Arbitrary-transect cross-section.** `/api/section?path=lon,lat;lon,lat;...`
  takes up to twelve waypoints and samples them at even spacing *in distance*,
  not per segment -- otherwise a short dogleg at the end of a long transect
  would be drawn at twenty times the resolution of the rest. The curtain is one
  column of vertices per waypoint, so a transect that turns is a folded surface
  that still follows its own track.
- **Arbitrary-quadrilateral selection.** Four freely placed corners. The server
  still receives the bounding box -- a NetCDF subset is a rectangle in index
  space and nothing else -- and the quad is applied where it can be applied
  exactly, as four vertical clipping planes in the renderer. The extra water is
  contiguous in the file and free to read; it simply is not shown. Concave or
  self-crossing quads fall back to the rectangle, because four half-spaces can
  only ever describe a convex region.
- **Event replay.** `/api/events` scans every timestep against the climatology
  and groups runs during which at least 10% of the region by area sat beyond
  the threshold. Events are drawn on the timeline scrubber, and one click jumps
  to the start and plays. On the real Indian Ocean catalogue it finds the
  2023–24 basin warming, peaking April 2024 at +2.1 °C over 72% of the region.
- **Search & navigation** is Ctrl+K, which resolves a phrase into a `Tool` call
  from the schema in spec 5.2 and shows the resolved call *before* running it.
  No model is involved -- see "The query layer" below.
- **Data provenance** reads each open file's own global attributes through
  `/api/provenance`. A provenance panel fed from a hand-written list is a
  claim; one fed from `ds.attrs` is a receipt, and it cannot drift when the
  catalogue is repointed.
- **One-click report** exports the view as PNG, the matchup table and the
  assessment grid as CSV, and the session plus the full provenance record as
  JSON. Every export carries its provenance in the header, because a table of
  biases that leaves without naming the model it came from is the artefact this
  platform exists to prevent.
- **Saved sessions** live in the URL: shareable, bookmarkable, reload-proof,
  and readable with one `atob()` when someone asks what a link contains.

**The one that is only partly possible: the Hobday marine-heatwave layer.**
Hobday et al. (2016) define a marine heatwave as SST above the seasonally
varying 90th percentile of a 30-year *daily* climatology, sustained for at
least five consecutive days. Two of those three criteria cannot be evaluated
here: the climatology carries a monthly mean and standard deviation rather than
a percentile distribution, and a monthly model cannot resolve a five-day
duration. So the threshold is a normal approximation to the 90th percentile
(mean + 1.2816σ), the area test is applied, the duration test is absent, and
the response calls the result an *exceedance event* and ships the reason with
every payload. Naming these marine heatwaves would be the easiest way to lose
the credibility the matchup statistics earn, in front of the one audience most
able to check.

### The query layer (spec 5.2), without a model

Spec 5.2 requires a deterministic keyword fallback in case a free tier
rate-limits mid-pitch. Here that fallback is the *default* path, and there is
no model call at all. A free-tier model is a third-party dependency, a rate
limit, and a prompt log containing a ministry's queries, in exchange for
parsing "bay of bengal" -- which a lookup table does correctly, offline, in
microseconds. The architecture the spec settles on is unchanged: everything
typed resolves to a `Tool` object against a fixed schema before anything
happens, the resolved call is displayed before it runs, and `query_floats` is
answered by `/api/instruments` against the observation index, so a ranking is
computed rather than generated. Wiring a model in later means emitting the same
`Tool` objects; nothing downstream changes.

### Level 3: the natural-language query layer

One Level 3 item is built, because 5.2 designs it as a schema rather than as a
chatbot and the schema was already there.

**A model is asked only about phrases the lookup table cannot parse.** That
ordering is the whole design. Everything rehearsed for the demo resolves
offline, for free, in microseconds, and identically every time; the model
handles the phrasing nobody anticipated, which is exactly where 5.2 argues
natural language earns its place. Pull the network out mid-pitch and the
feature still works.

Four guarantees, enforced in `backend/app/api/services/nlq.py` rather than
promised:

- **The model never touches the data.** It emits tool calls and nothing else.
  `query_floats` is answered by `/api/instruments` against the observation
  index, so a ranking is *measured*. No number a model produces is ever shown.
- **It can only say things the UI can already do.** Every call is validated
  against the live catalogue before it leaves the server — unknown tool,
  unknown variable, a depth outside the dataset, a timestamp the record does
  not contain: rejected, and the rejection count is reported. The blast radius
  of a hallucination is a discarded request.
- **Nothing runs silently.** The resolved call is printed above the list, rows
  a model proposed are marked `Model` in a different colour from locally
  matched ones, and a call executes only when the user chooses it.
- **It is never required.** No key, no network, a dead free tier, a renamed
  model — all degrade to the lookup table, and the response says which.

It adds no dependency: one POST with a timeout through `urllib.request`.
Adding an HTTP client so an *optional* feature can call an *optional* service
is how a stack acquires something that fails to install the night before.

**To enable it:** set `OCEANUPS_NLQ_API_KEY` (see `.env.example`) and restart
the API. `/api/query/status` and `/api/health` both report whether a model is
reachable. Any OpenAI-compatible endpoint works, so pointing
`OCEANUPS_NLQ_BASE_URL` at a local Ollama or vLLM server needs no key at all —
the self-hosted deployment 5.2 says production would require, since a ministry
would not route operational queries through a third-party API.

**Free-tier caveats, stated rather than discovered:** free OpenRouter models
generally log prompts and rate-limit aggressively. Only the catalogue's
vocabulary is sent — variable names, region ids, timestep strings, float
numbers — never measurements, and nothing about who is running it.

The rest of **Level 3** is not built, and the spec says it should not be: it is
listed as future work that "must not consume MVP hours".

Reduced fidelity, stated plainly: the extrude is a camera and opacity crossfade
rather than the pixel-registered map-to-block hand-off; the current layer's
playback is time-compressed (direction and relative speed are the model's, the
rate is not, and the UI says so); and the section track is a straight line in
longitude/latitude rather than a great circle, which over a selection-sized
span is smaller than the grid spacing (reported distances are still true
great-circle kilometres).
