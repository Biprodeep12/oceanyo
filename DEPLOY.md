# Deploy commands

Commands only. Rationale lives in [README.md](README.md); this is the card you
run from.

Two services: `api` (FastAPI/uvicorn, port 8000) and `web` (Next.js standalone,
port 3000).

---

## Docker (the normal path)

### 1. Generate the data first — on the host

`data/` is a **read-only bind mount**, not baked into the image. An empty
`data/` means the API fails its healthcheck and `web` never starts.

Even on the Docker path this runs on the **host**, so it needs a host Python
3.12 venv. It needs no `npm install` — the launcher uses only node builtins.

```bash
uv venv backend/.venv --python 3.12
VIRTUAL_ENV=backend/.venv uv pip install -r backend/requirements.txt

npm run synth                 # synthetic dataset, ~12 s, ~165 MB
npm run synth:tiny            # or a fast 15 MB version
npm run verify                # 40 assertions on the data contract
```

Real data instead (no account or credentials anywhere):

```bash
npm run fetch:hycom           # 1/12 deg model: HYCOM GOFS 3.1 (public domain)
npm run fetch:erddap          # chlorophyll (VIIRS) + bathymetry (ETOPO 2022)
npm run fetch:real            # Argo floats + an EGO glider deployment
npm run fetch:real -- --woa   # WOA23 climatology
```

### 2. Bring it up

```bash
docker compose up --build            # foreground
docker compose up --build -d         # detached
```

Open <http://localhost:3000>.

### 3. Check it

```bash
docker compose ps                    # api should read (healthy)
curl -fsS http://127.0.0.1:8000/api/health
docker compose logs -f api
docker compose logs -f web
```

`api` is healthy only once the dataset is open — allow up to 40 s
(`start_period`), then 12 retries at 10 s.

### 4. Stop

```bash
docker compose down                  # stop and remove containers
docker compose down --rmi local      # also drop the images built here
```

### Rebuild after a change

```bash
docker compose build api && docker compose up -d api   # backend only
docker compose build web && docker compose up -d web   # frontend only
docker compose up --build --force-recreate             # everything
```

Regenerating `data/` needs **no rebuild** — it is mounted, not copied.

---

## Choosing the dataset

Default is set in `docker-compose.yml` (`OCEANUPS_CATALOG`). Override without
editing the file:

```bash
OCEANUPS_CATALOG=/app/config/catalog.hycom.yaml docker compose up -d api
```

Available: `catalog.synthetic.yaml`, `catalog.hycom.yaml`,
`catalog.indian-ocean.yaml`, `catalog.glorys.yaml` (needs credentials).

The app's **Dataset** picker does the same thing at runtime by writing
`/app/.runtime/catalog.json` and exiting with code 3; `restart: unless-stopped`
is what starts it again. That choice survives a **restart**, not a
**recreate** — a new container starts from the compose value again.

```bash
docker compose exec api rm -f /app/.runtime/catalog.json   # back to the default
docker compose restart api
```

---

## Environment

`.env` is read on the **host** by compose and injected into `api`; it is
excluded from the image by `.dockerignore`. All of it is optional.

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `OCEANUPS_CATALOG` | Default catalog path. The entire real-data swap. |
| `OCEANUPS_DATA_ROOT` | Dataset root. `/app/data` in compose. |
| `OCEANUPS_CACHE_DIR` | Tile/derived cache. `/app/data/cache` in compose. |
| `OCEANUPS_ENABLE_XPUBLISH` | `false` skips the OGC WMS/OPeNDAP mount. The API boots either way. |
| `OCEANUPS_SUPERVISED` | `1` declares that something restarts the API, which is what enables the Dataset picker. |
| `OCEANUPS_RESTART_MODE` | `auto` \| `exit` \| `off`. Force the answer instead of detecting it. |
| `OCEANUPS_NLQ_API_KEY` | Optional. Without it the command palette uses its own lookup table. |
| `OCEANUPS_NLQ_MODEL` | OpenAI-compatible model id. |
| `OCEANUPS_NLQ_BASE_URL` | Point at `http://127.0.0.1:11434/v1` for local Ollama; the key is then unnecessary. |

---

## Ports

```
web   3000:3000              → all interfaces
api   127.0.0.1:8000:8000    → loopback only
```

`web` reaches the API over the compose network as `http://api:8000`, not
through the published port. Put a reverse proxy in front of 3000 for anything
outward-facing.

---

## Without Docker

Python **3.12** — not 3.13/3.14. The scientific stack (cartopy,
numba via datashader) has no wheels for newer CPython and falls back to
building from source.

```bash
# backend
uv venv backend/.venv --python 3.12
VIRTUAL_ENV=backend/.venv uv pip install -r backend/requirements.txt

# frontend
npm install
npm --prefix web install

# data
npm run synth
npm run verify
```

### Development

```bash
npm run dev                   # api on :8000 + web on :3000, both reloading
OCEANUPS_CATALOG=config/catalog.hycom.yaml npm run dev
```

### Production

```bash
# api
python -m uvicorn app.api.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

`next.config.ts` sets `output: "standalone"`, so the web server is **not**
`next start` — that prints `"next start" does not work with "output: standalone"
configuration` and exits 1. Run the traced server, which is also what the Docker
image does.

`standalone/` carries `server.js` and `node_modules` but **not** `.next/static`
or `public`; the server expects both beside it, so stage them after every build:

```bash
npm --prefix web run build
cp -r web/.next/static web/.next/standalone/.next/static
cp -r web/public       web/.next/standalone/public

cd web/.next/standalone
PORT=3000 HOSTNAME=0.0.0.0 NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:8000 \
  node server.js
```

A fresh clone has no `public/maplibre/`, and skipping it 404s the map's worker
at runtime rather than at build time:

```bash
npm --prefix web run sync:maplibre    # before build; postinstall also does it
```

Set `OCEANUPS_SUPERVISED=1` under systemd, pm2 or `docker run --restart` so the
Dataset picker is offered. With nothing supervising, `/api/catalogs` reports
`restart.supported: false`, the rows are disabled with the reason shown, and
nothing is killed.

---

## Verification

```bash
# CF-1.8 compliance — Docker only (cfchecker needs native UDUNITS-2)
docker compose run --rm api \
  python -m cfchecker.cfchecks -v 1.8 /app/data/real/hycom_indian_ocean.nc

# OGC endpoints
curl -fsS "http://127.0.0.1:8000/api/health"
curl -fsS "http://127.0.0.1:3000/wms?service=WMS&version=1.3.0&request=GetCapabilities"
```

Browser suites. Run them against a **production build**, never `next dev`, and
one stack at a time. Serve it the same way production does:

```bash
npm --prefix web run build
cp -r web/.next/static web/.next/standalone/.next/static
cp -r web/public       web/.next/standalone/public
(cd web/.next/standalone && PORT=3000 HOSTNAME=127.0.0.1 node server.js) &

npm run smoke                 # full demo path: 22 desktop + 5 mobile steps
npm run smoke:level2          # Level 2 surfaces only, ~1 min
npm run smoke:switch          # the dataset-picker restart path
```

The suites ask for **127.0.0.1**, not localhost, and editing source mid-run
remounts MapLibre and fails every step after it.

> Known: `smoke:level2` throws `Cannot read properties of undefined (reading
> 'bbox')` at its glider step on any catalog carrying a `mozambique_channel`
> preset — the harness's `store(page, fn)` helper drops the third argument it
> is passed there. Every check before it still reports. Unrelated to deployment.
