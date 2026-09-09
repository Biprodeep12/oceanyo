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
from pathlib import Path

from ..core.catalog import Catalog
from ..core.cf_adapter import CFDataset
from ..core.geometry import BBox
from ..core.models import ObservationProfile
from .obs.registry import REGISTRY, ProfileRef, load_builtin_parsers

log = logging.getLogger(__name__)


class DataStore:
    def __init__(self, catalog: Catalog) -> None:
        self.catalog = catalog
        self.model: CFDataset | None = None
        self.bgc: CFDataset | None = None
        self.bathymetry: CFDataset | None = None
        self.climatology: CFDataset | None = None
        self._refs: list[ProfileRef] = []
        self._lock = threading.Lock()

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
                log.info("%s: %s", attr, ref.uri.name)
            except Exception as exc:
                # An optional product missing must not stop the platform.
                log.warning("optional dataset %r unavailable (%s): %s", attr, ref.uri, exc)

        load_builtin_parsers()
        self.reindex_observations()
        log.info("datastore ready in %.1fs", time.time() - t0)

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
        for src in self.catalog.observations:
            if src.platform == ref.platform:
                return REGISTRY.get(src.parser).load(ref)
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
