# Python 3.12, not 3.13/3.14. The scientific stack under xpublish-wms pulls in
# cartopy and datashader->numba, and both lag new CPython releases by months.
# On 3.12 every dependency here resolves to a prebuilt wheel; on a newer tag
# pip silently falls back to building cartopy from source, which needs GEOS and
# a C++ toolchain and fails several minutes into the build.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# libexpat1 is needed by netCDF4/HDF5 at runtime; the -slim image omits it and
# the resulting ImportError names a symbol, not a package.
#
# libudunits2 is here so the CF-compliance CLAIM is checkable rather than
# asserted. `cfchecker` depends on `cfunits`, which needs UNIDATA's native
# UDUNITS-2 -- there is no Windows wheel for it outside conda, which is why the
# check cannot run on the development machine but runs in one line here:
#
#   docker compose run --rm api \
#     python -m cfchecker.cfchecks -v 1.8 /app/data/real/hycom_indian_ocean.nc
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libexpat1 curl libudunits2-0 udunits-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Requirements first so the dependency layer survives source edits: this layer
# takes minutes, the source layer takes a second.
COPY backend/requirements.txt ./backend/requirements.txt
COPY backend/requirements-cf.txt ./backend/requirements-cf.txt
RUN pip install --upgrade pip \
    && pip install -r backend/requirements.txt \
    && pip install -r backend/requirements-cf.txt

COPY backend/ ./backend/
COPY config/ ./config/

# The catalog path is the entire real-data swap surface. Override it to
# config/catalog.hycom.yaml (or catalog.glorys.yaml) with no image rebuild.
ENV OCEANUPS_CATALOG=/app/config/catalog.synthetic.yaml

EXPOSE 8000

# Bound to 0.0.0.0 INSIDE the container only. On the host this project binds
# 127.0.0.1 deliberately, to avoid a Windows Firewall prompt on every run; in a
# container there is no host firewall to trip and no other way to be reachable.
CMD ["python", "-m", "uvicorn", "app.api.main:app", \
     "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8000"]
