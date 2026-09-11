# Tech stack — SIH 26067

Interactive Ocean Data Visualization & Model–Observation Intelligence Platform ·
MoES / INCOIS. Each row says **what we use it for**, in plain words.

---

## Frontend (what the browser runs)

| Tech | What it does here |
|---|---|
| **Next.js 16 + React 19** (TypeScript) | The web app itself. It also forwards `/api`, `/tiles`, `/wms`, `/wcs` and `/opendap` to the Python server, so the browser only ever talks to one address — no CORS setup |
| **MapLibre GL JS** | The 2D map: coastline, colour-mapped data tiles, float and glider markers, and the rectangle you drag to pick a region. Free and open, no API key |
| **Three.js** (+ react-three-fiber, drei) | The 3D block you get after pressing Dive: water column, seabed, floats and gliders at their real depths |
| **Custom WebGL shaders** | Two jobs. One draws the water column by walking a ray through a 3D image of the data. The other moves thousands of current particles on the GPU |
| **Zustand** | Holds the app's state (variable, depth, time, selection) in one place |
| **Web Worker** | Unpacks the downloaded 3D data on a background thread, so the Dive animation never stutters |
| **Tailwind CSS** | Styling for the panels, rail and rows |
| **Playwright** | Runs the app in a real browser and checks 27 things work, plus a timed demo rehearsal |

## Backend (what the server runs)

| Tech | What it does here |
|---|---|
| **Python 3.12 + FastAPI** | The API — 29 endpoints, each one returning only the region you asked for. Auto-documented at `/docs` |
| **xarray + cf-xarray** | Reads the ocean data files. It finds latitude, longitude, depth and time from the file's own CF labels, not from variable names — which is why a HYCOM file and a GLORYS file both work with no code change |
| **NumPy / SciPy** | The maths: slicing the grid, lining the model up with a float's depths, and the error statistics |
| **scikit-image** | Builds isosurfaces (`marching_cubes`) on the server and sends them as a 3D mesh — too slow to do in the browser |
| **Pillow + Matplotlib** | Turns data into the coloured PNG map tiles |
| **xpublish (+ wms, opendap)** | Publishes the standard OGC **WMS** and **OPeNDAP** services other ocean tools can read. Loaded in a way that cannot stop the app starting if it fails |
| **Our own WCS router** | The OGC **WCS** service, which returns the raw data as a NetCDF file. No ready-made plugin does this |
| **Pydantic** | Defines every response shape, so the docs match reality |
| **PyYAML** | Reads the catalog files that say which data to load |
| **h5netcdf / netCDF4** | Opens NetCDF files. The right reader is picked per file, because real downloads and generated files use different formats |

## Data (where the numbers come from)

| Source | What it gives us |
|---|---|
| **HYCOM GOFS 3.1** | The real ocean model — temperature, salinity, currents. Public domain, no login |
| **Argo floats** (Ifremer/INCOIS) | Real measured profiles, with quality flags |
| **EGO gliders** (Ifremer) | Real glider dives |
| **VIIRS chlorophyll** | Real chlorophyll, on its own grid — ocean physics models do not include it |
| **ETOPO 2022 / GEBCO** | Seafloor depth: the seabed in 3D, and the coastline on the map |
| **NOAA WOA23** | A long-term average, used to show how unusual a month is |
| **Copernicus GLORYS12** | Supported too, but it needs a free account |
| **Our synthetic data** | The default. Built to look exactly like a real file, with a **known error added on purpose** so the comparison panel can be tested against a right answer |

## Running it

| Tech | What it does here |
|---|---|
| **Docker Compose** | Starts both halves with one command. The data folder is mounted, not copied into the image |
| **Node helper scripts** | One way to run every Python script on Windows, Mac and Linux — and the small supervisor that restarts the API when you switch datasets in the UI |
| **Typer** | The command line: generate data, verify it, fetch real data |

## Choices we made on purpose

- **A flat map, not a 3D globe.** Depth slices, isosurfaces and stretching the vertical axis are all easy on a flat block and awkward on a curved globe. A small inset map shows where you are.
- **Nothing to install.** It runs in a normal browser — the problem statement asks for this.
- **No third-party basemap.** The coastline is drawn from our own seafloor data, so nothing can fail to load during the demo.
- **No AI in the demo path.** Typed questions are matched offline by a lookup table; a language model is optional and never touches the data.
- **Plain NetCDF files, no database.** Files are opened once and kept in memory, which is fast enough and much simpler.
