"""CF convention truth table.

This module is the seam of the whole project: the synthetic generator WRITES
these attributes, and the CF adapter READS them. Because both directions go
through one table, swapping synthetic data for real GLORYS12 is a config
change rather than a rewrite.

Nothing in here may import from `app.api` or `app.pipeline`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

CF_CONVENTIONS = "CF-1.8"

# GLORYS12V1 uses this epoch; we mirror it so cftime handling is exercised
# from hour one instead of being discovered late against real data.
TIME_UNITS = "hours since 1950-01-01"
TIME_CALENDAR = "gregorian"


@dataclass(frozen=True)
class CanonicalVar:
    """One physical variable, in our canonical vocabulary."""

    key: str  # canonical key used across the API and the frontend
    glorys_name: str  # the name GLORYS12 (and our synthetic twin) stores it under
    standard_name: str  # CF standard_name — the primary resolution path
    units: str
    long_name: str
    valid: tuple[float, float]  # dataset-wide range; drives quantization + colour
    cmap: str
    log: bool = False
    aliases: tuple[str, ...] = field(default_factory=tuple)


CANONICAL: dict[str, CanonicalVar] = {
    "temperature": CanonicalVar(
        key="temperature",
        glorys_name="thetao",
        standard_name="sea_water_potential_temperature",
        units="degrees_C",
        long_name="Sea water potential temperature",
        valid=(-2.0, 36.0),
        cmap="thermal",
        aliases=("sea_water_conservative_temperature", "sea_water_temperature"),
    ),
    "salinity": CanonicalVar(
        key="salinity",
        glorys_name="so",
        standard_name="sea_water_salinity",
        units="1e-3",
        long_name="Sea water salinity",
        valid=(28.0, 38.0),
        cmap="haline",
        aliases=("sea_water_practical_salinity", "sea_water_absolute_salinity"),
    ),
    "u": CanonicalVar(
        key="u",
        glorys_name="uo",
        standard_name="eastward_sea_water_velocity",
        units="m s-1",
        long_name="Eastward sea water velocity",
        valid=(-2.5, 2.5),
        cmap="delta",
    ),
    "v": CanonicalVar(
        key="v",
        glorys_name="vo",
        standard_name="northward_sea_water_velocity",
        units="m s-1",
        long_name="Northward sea water velocity",
        valid=(-2.5, 2.5),
        cmap="delta",
    ),
    "chlorophyll": CanonicalVar(
        key="chlorophyll",
        glorys_name="chl",
        standard_name="mass_concentration_of_chlorophyll_a_in_sea_water",
        units="mg m-3",
        long_name="Mass concentration of chlorophyll a in sea water",
        valid=(0.0, 10.0),
        cmap="algae",
        log=True,
    ),
}

# reverse lookups, built once
BY_STANDARD_NAME: dict[str, CanonicalVar] = {}
BY_RAW_NAME: dict[str, CanonicalVar] = {}
for _cv in CANONICAL.values():
    BY_STANDARD_NAME[_cv.standard_name] = _cv
    for _alias in _cv.aliases:
        BY_STANDARD_NAME.setdefault(_alias, _cv)
    BY_RAW_NAME[_cv.glorys_name] = _cv


# --- coordinate attribute templates -------------------------------------
# The generator stamps these verbatim. The adapter's detection relies on them,
# so a change here propagates correctly to both sides.

LON_ATTRS = {
    "standard_name": "longitude",
    "long_name": "Longitude",
    "units": "degrees_east",
    "axis": "X",
}

LAT_ATTRS = {
    "standard_name": "latitude",
    "long_name": "Latitude",
    "units": "degrees_north",
    "axis": "Y",
}

# `positive="down"` is the attribute that makes an oceanographic depth axis
# unambiguous (CF: depth 0 at the surface increasing downward). The adapter
# keys off it, so it is not optional.
DEPTH_ATTRS = {
    "standard_name": "depth",
    "long_name": "Depth",
    "units": "m",
    "axis": "Z",
    "positive": "down",
}

TIME_ATTRS = {
    "standard_name": "time",
    "long_name": "Time",
    "axis": "T",
}


def variable_attrs(cv: CanonicalVar) -> dict[str, object]:
    """CF attributes for a data variable."""
    return {
        "standard_name": cv.standard_name,
        "long_name": cv.long_name,
        "units": cv.units,
        "valid_min": float(cv.valid[0]),
        "valid_max": float(cv.valid[1]),
    }


def global_attrs(*, title: str, synthetic: bool, source: str) -> dict[str, object]:
    """Dataset-level CF attributes. `synthetic` propagates all the way to the
    frontend badge, so provenance can never be silently lost."""
    return {
        "Conventions": CF_CONVENTIONS,
        "title": title,
        "institution": "SYNTHETIC" if synthetic else "CMEMS",
        "source": source,
        "synthetic": "true" if synthetic else "false",
    }


def resolve(name: str) -> CanonicalVar | None:
    """Best-effort lookup by canonical key, standard_name, alias, or raw name."""
    if name in CANONICAL:
        return CANONICAL[name]
    if name in BY_STANDARD_NAME:
        return BY_STANDARD_NAME[name]
    return BY_RAW_NAME.get(name)
