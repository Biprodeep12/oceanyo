"""Which xarray engine can actually read this file.

The synthetic generator writes NetCDF-4/HDF5, so the whole stack defaulted to
`h5netcdf`. Real Argo GDAC files are **NetCDF-3 classic** -- `h5netcdf` cannot
open them at all, and fails with "file signature not found", which reads like a
corrupt download rather than a format mismatch.

This is exactly the assumption a synthetic-first project is prone to bake in:
everything worked because we generated both sides. Sniffing the magic bytes
costs four bytes of I/O and makes the real-data swap actually work.

    CDF\\x01  NetCDF-3 classic         -> netcdf4 (or scipy)
    CDF\\x02  NetCDF-3 64-bit offset   -> netcdf4
    CDF\\x05  NetCDF-3 64-bit data     -> netcdf4
    \\x89HDF   HDF5 (NetCDF-4)          -> h5netcdf
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)

#: Engine name meaning "look at the file and decide".
AUTO = "auto"


def sniff_engine(path: str | Path, default: str = "h5netcdf") -> str:
    """Return the xarray engine that can read `path`.

    Falls back to `default` for anything unrecognised (a remote URI, an OPeNDAP
    endpoint, a zero-length file) rather than guessing -- the caller then gets
    the engine's own error, which is more informative than ours.
    """
    p = Path(path)
    try:
        with open(p, "rb") as fh:
            magic = fh.read(4)
    except OSError:
        return default

    if magic[:4] == b"\x89HDF":
        return "h5netcdf"
    if magic[:3] == b"CDF":
        return "netcdf4"
    return default


def open_dataset(path: str | Path, *, engine: str | None = None, **kwargs):
    """`xr.open_dataset` with the engine sniffed unless one is forced.

    Pass `engine="auto"` or None to sniff; pass a real engine name to override,
    which the catalog does for datasets whose format is known.
    """
    import xarray as xr

    chosen = sniff_engine(path) if engine in (None, AUTO) else engine
    try:
        return xr.open_dataset(path, engine=chosen, **kwargs)
    except Exception:
        # A file can be readable by the other engine even when the magic bytes
        # suggest otherwise (h5netcdf refuses some valid NetCDF-4 files that
        # netcdf4 opens happily). One retry, then let the error through.
        other = "netcdf4" if chosen == "h5netcdf" else "h5netcdf"
        log.warning("engine %r failed for %s; retrying with %r", chosen, path, other)
        return xr.open_dataset(path, engine=other, **kwargs)
