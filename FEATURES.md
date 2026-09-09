# Features

Interactive ocean data visualization and model–observation intelligence for the
Indian EEZ. **SIH 26067** · Ministry of Earth Sciences / INCOIS.

> **All data shown is synthetically generated.** It is CF-1.8 compliant and
> shaped exactly like GLORYS12V1, so switching to real reanalysis is a config
> change, not a rewrite. Nothing here is an observation or a forecast, and the
> UI says so on every screen.

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

Press **Dive** and the selected footprint lifts off the map into a 3D block —
a 1500 ms eased camera-and-opacity transition with both canvases mounted
throughout. If the water column has not arrived it **holds at the tilted
state** with the seabed visible rather than freezing, and completes the moment
data lands.

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
- **OPeNDAP** — `/opendap.dds`, `/opendap.das`
- **21 REST endpoints**, self-documented at `/docs`
- Mounted **fail-soft**: the API boots in seconds even if the standards stack
  fails, and `/api/health` reports what actually came up

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
- **40-assertion data contract** + **21-step browser smoke test**, both run
  against whichever catalog is configured

## What is deliberately not claimed

- This is **not a warning system**. It is an exploration and validation tool,
  complementary to INCOIS operational products.
- The extrude is a camera/opacity crossfade, not a pixel-registered hand-off.
- Current playback is time-compressed; direction and relative speed are the
  model's, the rate is not.
- The section track is a straight line in lon/lat, not a great circle —
  smaller than the grid spacing at this scale. Distances are true
  great-circle kilometres.
- The block's vertical axis follows model levels, not metres, so the upper
  ocean fills most of the block and the abyss is compressed.
