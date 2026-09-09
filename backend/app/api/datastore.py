"""Process-wide handle on the configured catalog.

Opens the model, BGC, bathymetry and climatology datasets once at startup and
indexes the observations. Everything is held in memory: the synthetic dataset
is a few hundred MB and there is exactly one concurrent user, so eager loading
beats lazy chunked reads and removes a whole class of file-handle problems on
Windows.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from pathlib import Path

from ..core.catalog import Catalog
from ..core.cf_adapter import CFDataset
from ..core.geometry import BBox
from ..core.models import ObservationProfile
from .obs.registry import REGISTRY, ProfileRef, load_builtin_parsers

log = logging.getLogger(__name__)



#: standard_names that mean "height of the solid surface", in the order we
#: trust them. GEBCO and ETOPO both store elevation positive UP with negative
#: values below sea level, which is what the seabed mesh expects.
_BATHY_STANDARD_NAMES = (
    "height_above_mean_sea_level",
    "altitude",
    "surface_altitude",
)
_BATHY_FALLBACK_NAMES = ("elevation", "z", "Band1", "altitude", "topo")


def resolve_bathymetry_var(ds, declared: str | None) -> str:
    """Find the elevation variable in a bathymetry file.

    The catalog carries a `variable:` key for exactly this, but relying on it
    alone means every new source needs a config edit; relying on the name
    `elevation` alone means only GEBCO works, and ETOPO 2022 calls it `z`.
    So: the catalog wins, then CF, then the names these products actually use,
    then -- if the file holds exactly one field -- that field.
    """
    if declared and declared in ds.data_vars:
        return declared
    for name, da in ds.data_vars.items():
        if str(da.attrs.get("standard_name", "")) in _BATHY_STANDARD_NAMES:
            return str(name)
    for cand in _BATHY_FALLBACK_NAMES:
        if cand in ds.data_vars:
            return cand
    if len(ds.data_vars) == 1:
        return str(next(iter(ds.data_vars)))
    raise ValueError(
        f"cannot identify the elevation variable among {list(ds.data_vars)}; "
        "name it with `bathymetry.variable` in the catalog"
    )

class DataStore:
    def __init__(self, catalog: Catalog) -> None:
        self.catalog = catalog
        self.model: CFDataset | None = None
        self.bgc: CFDataset | None = None
        self.bathymetry: CFDataset | None = None
        #: Raw variable holding elevation in the bathymetry file. The
        #: catalog may name it; otherwise it is resolved on open.
        self.bathymetry_var: str = "elevation"
        self.climatology: CFDataset | None = None
        self._refs: list[ProfileRef] = []
        self._lock = threading.Lock()
        # Loading a profile means opening a NetCDF file. The matchup summary
        # walks hundreds of them, and the same profiles are re-read on every
        # variable change, so the open dominates the endpoint. Cache the parsed
        # results; they are small and immutable for a given dataset.
        self._profiles: OrderedDict[tuple[str, str], ObservationProfile] = OrderedDict()
        self._profile_cache_max = 4000

    # -- lifecycle --------------------------------------------------------
    def open_all(self) -> None:
        cat = self.catalog
        t0 = time.time()

        self.model = CFDataset.open(
            cat.model.uri,
            source=cat.source,
            synthetic=cat.synthetic,
            var_map=cat.model.variables,
            engine=cat.model.engine,
        )
        log.info(
            "model: %s vars=%s grid=%s",
            cat.model.uri.name, self.model.canonical_vars(), dict(self.model.ds.sizes),
        )

        for attr, ref in (("bgc", cat.bgc), ("bathymetry", cat.bathymetry),
                          ("climatology", cat.climatology)):
            if ref is None:
                continue
            try:
                setattr(self, attr, CFDataset.open(
                    ref.uri, source=cat.source, synthetic=cat.synthetic,
                    var_map=ref.variables, engine=ref.engine,
                ))
                if attr == "bathymetry" and self.bathymetry is not None:
                    self.bathymetry_var = resolve_bathymetry_var(
                        self.bathymetry.ds, ref.variable
                    )
                    log.info(
                        "bathymetry: %s (elevation variable %r)",
                        ref.uri.name, self.bathymetry_var,
                    )
                else:
                    log.info("%s: %s", attr, ref.uri.name)
            except Exception as exc:
                # An optional product missing must not stop the platform.
                log.warning("optional dataset %r unavailable (%s): %s", attr, ref.uri, exc)

        load_builtin_parsers()
        self.reindex_observations()
        log.info("datastore ready in %.1fs", time.time() - t0)

    def prewarm(self) -> None:
        """Load every indexed profile into the cache.

        The matchup summary that colours the instrument markers otherwise pays
        the cost of opening a few hundred NetCDF files on its first call, which
        lands squarely on the demo path. Runs on a background thread at
        startup, so the API is usable immediately and this finishes behind it.
        """
        t0 = time.time()
        refs = self.observation_refs()
        loaded = 0
        for ref in refs:
            try:
                self.load_profile(ref)
                loaded += 1
            except Exception:
                continue
        log.info("prewarmed %d/%d profiles in %.1fs", loaded, len(refs), time.time() - t0)

    def close(self) -> None:
        for d in (self.model, self.bgc, self.bathymetry, self.climatology):
            if d is not None:
                d.ds.close()

    # -- observations -----------------------------------------------------
    def reindex_observations(self) -> None:
        """Discover every profile from every configured source, once."""
        refs: list[ProfileRef] = []
        for src in self.catalog.observations:
            try:
                parser = REGISTRY.get(src.parser)
            except KeyError as exc:
                log.error("catalog references unknown parser: %s", exc)
                continue
            try:
                found = parser.discover(Path(src.uri), None, None, None)
                refs.extend(found)
                log.info("indexed %d %s profiles via %s", len(found), src.platform, src.parser)
            except Exception as exc:
                log.warning("discovery failed for %s (%s): %s", src.platform, src.uri, exc)
        with self._lock:
            self._refs = refs
            self._profiles.clear()

    def observation_refs(
        self,
        *,
        bbox: BBox | None = None,
        platform: str | None = None,
        t0: str | None = None,
        t1: str | None = None,
    ) -> list[ProfileRef]:
        with self._lock:
            refs = list(self._refs)
        out = []
        for r in refs:
            if platform and r.platform != platform:
                continue
            if bbox is not None and not (
                bbox.west <= r.lon <= bbox.east and bbox.south <= r.lat <= bbox.north
            ):
                continue
            if t0 and r.time < t0:
                continue
            if t1 and r.time > t1:
                continue
            out.append(r)
        return out

    def find_ref(self, platform: str, profile_id: str) -> ProfileRef | None:
        with self._lock:
            for r in self._refs:
                if r.platform == platform and r.id == profile_id:
                    return r
        return None

    def load_profile(self, ref: ProfileRef) -> ObservationProfile:
        key = (ref.platform, ref.id)
        with self._lock:
            hit = self._profiles.get(key)
            if hit is not None:
                self._profiles.move_to_end(key)
                return hit

        for src in self.catalog.observations:
            if src.platform == ref.platform:
                profile = REGISTRY.get(src.parser).load(ref)
                with self._lock:
                    self._profiles[key] = profile
                    while len(self._profiles) > self._profile_cache_max:
                        self._profiles.popitem(last=False)
                return profile
        raise KeyError(f"no configured source for platform {ref.platform!r}")

    def platforms(self) -> list[str]:
        return sorted({s.platform for s in self.catalog.observations})

    # -- variables --------------------------------------------------------
    def dataset_for(self, variable: str) -> CFDataset:
        """Route a canonical variable to whichever product carries it.

        Chlorophyll lives in the BGC product on a coarser grid; everything else
        is in the physics model. Callers never need to know which.
        """
        if self.model is not None and variable in self.model.canonical_vars():
            return self.model
        if self.bgc is not None and variable in self.bgc.canonical_vars():
            return self.bgc
        raise KeyError(f"variable {variable!r} is not available in this catalog")

    def all_variables(self) -> list[str]:
        out: list[str] = []
        for d in (self.model, self.bgc):
            if d is not None:
                out.extend(v for v in d.canonical_vars() if v not in out)
        return out


_store: DataStore | None = None


def get_store() -> DataStore:
    if _store is None:
        raise RuntimeError("datastore not initialised; the app lifespan must run first")
    return _store


def init_store(catalog: Catalog) -> DataStore:
    global _store
    _store = DataStore(catalog)
    _store.open_all()
    return _store


def shutdown_store() -> None:
    global _store
    if _store is not None:
        _store.close()
        _store = None
