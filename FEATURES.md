# Features

Interactive ocean data visualization and model–observation intelligence for the
Indian EEZ. **SIH 26067** · Ministry of Earth Sciences / INCOIS.

> **The default catalog is synthetically generated.** It is CF-1.8 compliant
> and shaped exactly like GLORYS12V1, so switching to real data is a config
> change, not a rewrite. Nothing in it is an observation or a forecast, and the
> UI says so on every screen.
>
> **There is also a fully real catalog**, and none of it needs an account:
> `OCEANUPS_CATALOG=config/catalog.hycom.yaml npm run dev`. See section 5b.

---

## 1. Map mode

| Feature | What it does |
|---|---|
| **Full-bleed map** | MapLibre GL, Indian EEZ / Bay of Bengal, no page chrome |
| **Field tiles** | Server-rendered 256×256 XYZ PNG tiles, colour-mapped per variable |
| **5 variables** | Temperature, salinity, eastward/northward current, chlorophyll |
| **Depth slider** | Any model level, 0–2000 m; tiles re-render live |
| **Timeline** | 30 daily steps, play/pause, step forward and back, jump to end |
| **Pointer readout** | Value under the cursor + lat/lon in degrees-minutes, sampled locally from one cached grid — no request per mouse move |
| **Instrument markers** | Argo floats and gliders, **coloured by model−observation error** |
| **Anomaly layer** | Departure from climatology in σ, diverging scale centred at zero |
| **Coastline** | Traced from the project's own bathymetry — no remote basemap to stall |
| **Region select** | Shift+drag a rectangle, four draggable corner handles, or named presets |

## 2. The extrude

Press **Dive** and the map first **centres the selection**, then hands it to
the 3D scene **pixel for pixel**: the block's lid lands on the very rectangle
the map was showing — measured at **0.0 px** horizontally and within ~0.7%
vertically, which is Mercator's latitude stretch — wearing the same image,
fetched from the same renderer as the map tiles. The block then grows downward
out of that rectangle while the camera swings to its viewing position, with the
map still visible around it until the block covers it.

If the water column has not arrived it **holds at the tilted state** with the
seabed visible rather than freezing, and completes the moment data lands.
**Back to map** flies the same arc in reverse, starting from wherever you
orbited to.

## 3. Block mode (3D)

| Feature | What it does |
|---|---|
| **Volume rendering** | GPU ray-marching through a 3D texture; adaptive step count (cheap while moving, high quality when idle) |
| **Seabed mesh** | GEBCO-convention bathymetry, with the water column masked below it |
| **Depth plane** | Translucent plane at the selected depth, walks the thermocline |
| **Isosurface** | Server-side marching cubes → binary glTF, at the same LOD as the volume |
| **Current particles** | GPU advection over an RG-packed velocity texture, depth-aware |
| **Cross-section** | Click two points on the surface → a vertical curtain sampled at the model's own levels |
| **Instruments in 3D** | Argo floats as one instanced draw call; gliders with torpedo-and-wing geometry on their real sawtooth flight path |
| **Vertical exaggeration** | 1× – 10×, applied client-side so no geometry is refetched |
| **Colour scale editor** | Palette, min/max, log/linear — driving map tiles *and* the volume shader from one value |

## 4. Model vs observation — the differentiator

Click any float or glider in the water column:

- Its **measured profile** against the model interpolated onto the same depths
- **Bias · RMSE · MAE · correlation**, plus σ_obs, σ_model and centred RMSE
- A **Taylor diagram** — normalised standard deviation, correlation and centred
  RMSE as one point against a perfect-model reference, which is how operational
  ocean-model validation is reported and what an INCOIS evaluator will
  recognise on sight
- Colocation is explicit: matched within a stated radius and time window
- **QC-aware**: statistics use flag 1 (good) only; display keeps 1 and 2
- Data mode (R / A / D) shown per profile

Because observations are the model field plus a **known injected bias**, the
panel must recover it. It does: **+0.313 °C against +0.300 expected**, and
**−0.0499 against −0.0500 psu**. That single assertion exercises generator →
NetCDF → CF adapter → colocation → vertical interpolation → statistics, and it
caught three real science bugs during development.

## 5. Standards and interoperability

- **CF-1.8** conventions end to end — `standard_name`, `units`, `axis`,
  `positive="down"`, GLORYS variable names, `hours since 1950-01-01`
- **OGC WMS** — `GET /wms?service=WMS&version=1.3.0&request=GetCapabilities`
- **OGC WCS 2.0.1** — `GetCapabilities`, `DescribeCoverage`, `GetCoverage`
  returning CF NetCDF trimmed by lat/long/depth/time. Core profile only, and
  the docs say which parts of the standard are absent rather than advertising
  them and failing
- **OPeNDAP** — `/opendap.dds`, `/opendap.das`
- **29 REST endpoints** under `/api`, self-documented at `/docs`
- Mounted **fail-soft**: the API boots in seconds even if the standards stack
  fails, and `/api/health` reports what actually came up

## 5b. Real data, not just a claim

Every layer can be real, and **not one of them needs an account**:

```bash
npm run fetch:hycom     # model      HYCOM GOFS 3.1, 1/12 deg, 40 levels
npm run fetch:erddap    # chl+bathy  VIIRS chlorophyll, ETOPO 2022
npm run fetch:real      # obs        Argo + EGO gliders (Ifremer GDACs)
npm run fetch:real -- --woa         # climatology  NOAA WOA23

OCEANUPS_CATALOG=config/catalog.hycom.yaml npm run dev
```

| Layer | Source | Result |
|---|---|---|
| **Model** | HYCOM GOFS 3.1 (public domain) | 1/12 deg, 40 levels to 5000 m, T/S/U/V |
| **Chlorophyll** | VIIRS SNPP+NOAA-20, gap-filled | daily, its own grid — physics models carry no BGC |
| **Bathymetry** | ETOPO 2022, NOAA NCEI | 30 arc-second, −4710 m to +3002 m |
| **Argo**, INCOIS DAC | Ifremer GDAC | 800 profiles, **0 failures**, 44,352 levels |
| **EGO glider** | Ifremer GDAC | 192 dives/climbs, **0 failures**, deepest 1270 m |
| **Climatology** | NOAA WOA23 | 0.4 MB, drives the anomaly layer with no code change |

**And you can switch between them from the app.** The **Dataset** section at
the top of the layers panel lists every catalog in `config/`, with the live one
checked and any whose files are not on disk greyed out next to the command that
fetches them. Choosing one restarts the API — a hot swap would leave the OGC
WMS and OPeNDAP endpoints serving the previous dataset, because xpublish is
mounted once at startup against the dataset that was open then — and the page
reloads itself when the new catalog is live, in about six seconds here.

### Real model vs real floats

With the real catalog the matchup panel compares **HYCOM against Argo floats
that were profiling in the Bay of Bengal at the time**:

| | profiles | mean bias | mean RMSE |
|---|---|---|---|
| HYCOM vs Argo, ±36 h | 5 | **−0.002 °C** | **0.65 °C** |

Getting there took fixing four things real data exposed and synthetic data
could not:

- **The matchup time window was reported but never applied** — a 2002 profile
  was being compared against a 2024 model. Enforcing it cut 259 "matchups" to
  the 5 that are real, and *improved* the statistics from −0.320/1.02.
- **Real Argo reports 6552 dbar in 4100 m of water.** Pressure now gets its own
  QC and range test, separate from the value tests.
- **Real bathymetry disagrees with real floats by ~0.5%** — because we read
  decibars as metres. The seabed check has a physical tolerance now.
- **The climatology was keyed on the model's variable names**, so WOA23
  (`thetao_mean`) against HYCOM (`water_temp`) reported no climatology at all.

**HYCOM is a harder test than GLORYS12 would have been.** GLORYS calls
temperature `thetao` — which is what our generator writes, because it was built
to GLORYS's shape, so that swap would never have exercised name resolution at
all. HYCOM calls it `water_temp`. It resolves through CF `standard_name` with an
**empty `variables:` map** in the catalog. Four datasets, four grids, four
conventions, no regridding.

It failed the first time, three ways, and every one was invisible while both
sides of the pipeline were generated here:

- Real GDAC files are **NetCDF-3 classic** -- `h5netcdf` cannot open them at all
- Real QC flags are **characters with blanks**; `.astype(int)` killed 762 of 840 profiles
- Real EGO files are a **time series, not profiles** -- the parser would have
  read a whole 66,000-sample deployment as one dive to 1000 m and back

All fixed, and the generator now writes the same encodings, so the two sides
finally exercise one code path. Two bonus findings: the EGO index carries
**transposed coordinates** for some deployments (one claims the Bay of Bengal
and sits off Svalbard), and there are **no Bay of Bengal glider deployments in
the GDAC at all** -- 131 of 1115 are Indian Ocean, nearly all Mozambique
Channel.

## 5c. Runs on a phone

Panels become dismissable sheets, the layer list moves behind a rail button,
and regions are selected by **tapping two corners** -- shift+drag cannot exist
on a touch screen, and without a replacement the 3D block would be unreachable.
A tap probes the field where a mouse would hover, the block camera is fitted to
the viewport rather than a fixed position, and the hints name the gesture the
reader actually has. Five mobile steps run in the smoke test on every pass.

## 6. Plugin architecture for observations

A decorator-based parser registry. Adding a platform is **one file** — no
schema change, no new endpoint, no frontend change:

```python
@register("my_format", platform="mooring")
class MyParser(ObservationParser):
    def discover(...): ...
    def load(...): ...
```

Three ship in the box: **Argo core-profile NetCDF**, **EGO glider v1.5**, and
**CTD CSV**. `GET /api/platforms` lists every registered parser and its
capabilities, so the claim is inspectable rather than architectural.

## 7. Provenance, enforced in code

`synthetic: true` flows from the catalog YAML → `/api/health` → a permanent
amber **SYNTHETIC** chip in the UI → every `GriddedField.source`. The synthetic
coastline is labelled synthetic in its own API response. Provenance is a data
path, not a promise to remember.

## 8. Engineering notes

- **No CORS anywhere** — Next rewrites proxy everything same-origin
- **Binary volume wire format** — `[uint32 len][JSON header][quantized bytes]`,
  one round trip, decoded in a Web Worker
- **Raw 0 reserved for fill**, so the shader discards land with no mask texture
- **Dataset-wide colour limits**, so the volume never flickers between frames
- **GPU capability probe** at runtime → quality tier, shown in the UI
- **Texture disposal on exit**, so the tenth region selection does not crash
- **40-assertion data contract** + a **27-step browser smoke test** (22
  desktop, 5 mobile), both run against whichever catalog is configured
- **Engine sniffed per file**, because real GDAC products are NetCDF-3 and
  generated ones are NetCDF-4
- **`docker compose up --build`** — two services, data bind-mounted read-only
  rather than baked into an image (authored, not run: no Docker daemon here)
- **One Node launcher for every Python script**, because
  `backend/.venv/Scripts/python.exe` is unrunnable by cmd.exe, which npm uses
  on Windows — it reads the leading slash as a switch and reports
  `'backend' is not recognized`

## What is deliberately not claimed

- This is **not a warning system**. It is an exploration and validation tool,
  complementary to INCOIS operational products.
- Current playback is time-compressed; direction and relative speed are the
  model's, the rate is not.
- The section track is a straight line in lon/lat, not a great circle —
  smaller than the grid spacing at this scale. Distances are true
  great-circle kilometres.
- The block's vertical axis follows model levels, not metres, so the upper
  ocean fills most of the block and the abyss is compressed.
