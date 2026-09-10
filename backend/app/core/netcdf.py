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
import threading
from collections import OrderedDict
from contextlib import contextmanager
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


# --------------------------------------------------------------- open cache --
#
# One Argo GDAC file holds every cycle a float has ever reported -- 461 of them
# for 2900228 -- and the profile index keys on cycles, so loading "all the
# profiles" meant opening the same five files nine hundred and ninety-two
# times. Startup prewarm took 355 s, and any request that arrived during it
# competed with it: the first regional assessment took over two minutes.
#
# The fix is not a faster parser, it is opening each file once.
#
# Three properties this cache has to have, and why:
#
#   * **Fully loaded.** `.load()` pulls the arrays into memory, so a cached
#     dataset is plain numpy from then on. That is what makes it safe to hand
#     the same object to the prewarm thread and a request thread at once --
#     HDF5 handles are not reliably thread-safe, and an observation file is
#     single-digit megabytes, so there is nothing to gain by keeping it lazy.
#
#   * **Bounded.** Five files here; a full GDAC mirror is hundreds of
#     thousands. The budget is in bytes rather than entries because file sizes
#     vary by two orders of magnitude, and a file too large to cache is served
#     uncached rather than refused.
#
#   * **Safe to evict while in use.** Eviction closes the file handle, and the
#     values are already in memory, so a caller still holding an evicted
#     dataset keeps reading valid arrays.

#: Total decoded bytes to keep resident. This catalogue's five observation
#: files come to about 7 MB, so the budget only matters for a large GDAC
#: mirror -- where it is what stops the cache becoming the memory leak it was
#: meant to prevent.
CACHE_BUDGET_BYTES = 512 * 1024 * 1024

#: A single file bigger than this is never cached -- loading it would evict
#: everything else to hold one dataset that is probably a model, not an
#: observation file, and has no business in this cache.
CACHE_MAX_FILE_BYTES = 128 * 1024 * 1024


class _DatasetCache:
    def __init__(self) -> None:
        self._items: OrderedDict[str, object] = OrderedDict()
        self._bytes: dict[str, int] = {}
        self._total = 0
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def acquire(self, path: str | Path, engine: str | None) -> tuple[object, bool]:
        """Return (dataset, cached). When `cached` is False the caller closes it."""
        key = str(Path(path))
        with self._lock:
            hit = self._items.get(key)
            if hit is not None:
                self._items.move_to_end(key)
                self.hits += 1
                return hit, True
            self.misses += 1

        # Opened OUTSIDE the lock: a cold cache on a large catalog would
        # otherwise serialise every reader behind one file read. Two threads
        # racing on the same path open it twice and one copy is discarded,
        # which is cheaper than the contention and cannot deadlock.
        ds = open_dataset(key, engine=engine)
        try:
            nbytes = int(getattr(ds, "nbytes", 0))
        except Exception:
            nbytes = 0
        if nbytes > CACHE_MAX_FILE_BYTES:
            log.info("not caching %s (%.0f MB)", Path(key).name, nbytes / 1e6)
            return ds, False

        ds = ds.load()

        with self._lock:
            existing = self._items.get(key)
            if existing is not None:
                # Another thread won the race; keep theirs so every caller
                # shares one object, and drop ours.
                self._items.move_to_end(key)
                ds.close()
                return existing, True
            self._items[key] = ds
            self._bytes[key] = nbytes
            self._total += nbytes
            while self._total > CACHE_BUDGET_BYTES and len(self._items) > 1:
                old_key, old_ds = self._items.popitem(last=False)
                self._total -= self._bytes.pop(old_key, 0)
                # Safe: the arrays are already in memory, so a caller still
                # holding this dataset keeps reading valid values.
                old_ds.close()
        return ds, True

    def clear(self) -> None:
        with self._lock:
            for ds in self._items.values():
                try:
                    ds.close()
                except Exception:
                    pass
            self._items.clear()
            self._bytes.clear()
            self._total = 0

    def stats(self) -> dict:
        with self._lock:
            return {
                "files": len(self._items),
                "bytes": self._total,
                "hits": self.hits,
                "misses": self.misses,
            }


_CACHE = _DatasetCache()


@contextmanager
def cached_dataset(path: str | Path, *, engine: str | None = None):
    """Open `path` once and share it, closing it only if it was not cached.

    Written as a context manager so call sites keep the `with open(...) as ds`
    shape they already had: whether a dataset is shared or owned is this
    function's problem, not the parser's, and a parser that has to remember
    which one it got is a parser that will eventually close a shared handle.
    """
    ds, cached = _CACHE.acquire(path, engine)
    try:
        yield ds
    finally:
        if not cached:
            ds.close()


def clear_dataset_cache() -> None:
    """Drop every cached dataset. Called when the datastore reindexes or shuts down."""
    _CACHE.clear()


def dataset_cache_stats() -> dict:
    return _CACHE.stats()
