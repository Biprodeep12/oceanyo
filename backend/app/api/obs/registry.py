"""Observation parser registry -- the plugin extension point.

Spec section 3 makes `platform` an extensible enum and section 5 item 15 makes
the plugin architecture an MVP requirement. That claim is only worth anything
if it is real code, so:

  * parsers register themselves with a decorator at import time,
  * every parser returns the SAME `ObservationProfile` type,
  * `GET /api/platforms` exposes what is registered.

Adding CTD, moorings, HF-radar or ADCP support means writing one parser. No
schema change, no endpoint change, no frontend change.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from ...core.geometry import BBox
from ...core.models import ObservationProfile, ParserCapabilities

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProfileRef:
    """A discovered profile, cheap to list and enough to locate the full record."""

    platform: str
    id: str
    lat: float
    lon: float
    time: str
    path: Path
    index: int = 0
    data_mode: str = "R"


@runtime_checkable
class ObservationParser(Protocol):
    """What every observation source must implement."""

    platform: str

    def capabilities(self) -> ParserCapabilities: ...

    def discover(self, root: Path, bbox: BBox | None, t0: str | None, t1: str | None
                 ) -> list[ProfileRef]: ...

    def load(self, ref: ProfileRef) -> ObservationProfile: ...


class ParserRegistry:
    def __init__(self) -> None:
        self._parsers: dict[str, ObservationParser] = {}

    def register(self, cls):
        """Class decorator. Instantiates once and registers under `parser_id`."""
        instance = cls()
        pid = getattr(cls, "parser_id", None) or cls.__name__.lower()
        self._parsers[pid] = instance
        log.info("registered observation parser %r (platform=%s)", pid, instance.platform)
        return cls

    def get(self, parser_id: str) -> ObservationParser:
        if parser_id not in self._parsers:
            raise KeyError(
                f"no parser registered as {parser_id!r}; "
                f"available: {sorted(self._parsers)}"
            )
        return self._parsers[parser_id]

    def ids(self) -> list[str]:
        return sorted(self._parsers)

    def all(self) -> dict[str, ObservationParser]:
        return dict(self._parsers)

    def capabilities(self) -> list[ParserCapabilities]:
        return [p.capabilities() for p in self._parsers.values()]


REGISTRY = ParserRegistry()


def load_builtin_parsers() -> None:
    """Import the bundled parsers so their decorators run.

    Called from the app lifespan. Kept explicit rather than magic so the import
    order is obvious and a broken parser fails loudly at startup.
    """
    from .parsers import argo_netcdf, ctd_csv, glider_ego  # noqa: F401

    log.info("observation parsers available: %s", REGISTRY.ids())
