"""OGC WCS 2.0.1 -- the third standard MVP item 21 asks for.

xpublish gives us WMS (a picture of the data) and OPeNDAP (a subset of the
array). WCS is the third thing an institutional user asks for and the one the
problem statement names alongside WMS: give me *the coverage itself*, over
HTTP, in a format my desktop GIS or my Python script can open, subset to the
box I care about.

Scope, stated plainly rather than implied
-----------------------------------------
This is the **WCS 2.0.1 core profile over KVP**: GetCapabilities,
DescribeCoverage and GetCoverage with trimming subsets. It is not a full
implementation -- there is no scaling, interpolation, range subsetting or
CRS reprojection extension, and coverages are advertised in their native
CRS84. Those are real parts of the standard and pretending otherwise in a
GetCapabilities document is worse than omitting them, because a client will
try to use what it is told exists.

What it does support is the operation that matters here: a bbox + depth + time
trim returning CF-compliant NetCDF, which is the same array the rest of the API
serves, through the same CFDataset orientation contract. A user who trusts the
WCS output and the REST output can be sure they got the same numbers.

    /wcs?service=WCS&version=2.0.1&request=GetCapabilities
    /wcs?service=WCS&version=2.0.1&request=DescribeCoverage&coverageId=temperature
    /wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=temperature
        &subset=Lat(10,18)&subset=Long(85,92)&subset=depth(0,200)
"""

from __future__ import annotations

import io
import logging
import re
from xml.sax.saxutils import escape

import numpy as np
import xarray as xr
from fastapi import APIRouter, Depends, Query, Request, Response

from ...core.conventions import CF_CONVENTIONS
from ...core.geometry import BBox, DepthRange
from ..datastore import DataStore, get_store

log = logging.getLogger(__name__)
router = APIRouter(tags=["standards"])

WCS_VERSION = "2.0.1"
NETCDF_MIME = "application/x-netcdf"
XML_MIME = "text/xml; charset=utf-8"

NS = (
    'xmlns:wcs="http://www.opengis.net/wcs/2.0" '
    'xmlns:ows="http://www.opengis.net/ows/2.0" '
    'xmlns:gml="http://www.opengis.net/gml/3.2" '
    'xmlns:gmlcov="http://www.opengis.net/gmlcov/1.0" '
    'xmlns:swe="http://www.opengis.net/swe/2.0" '
    'xmlns:xlink="http://www.w3.org/1999/xlink"'
)

# subset=Lat(5,22) | subset=Lat(5) | subset=time("2023-01-05T00:00:00Z")
_SUBSET = re.compile(
    r'^(?P<axis>[A-Za-z_][\w]*)\((?P<low>"?[^,")]*"?)(?:,(?P<high>"?[^,")]*"?))?\)$'
)

# WCS axis labels are not CF axis names. Accept both, plus the spellings
# clients actually send.
_LON_AXES = {"long", "lon", "longitude", "x", "e"}
_LAT_AXES = {"lat", "latitude", "y", "n"}
_DEPTH_AXES = {"depth", "z", "elevation", "vertical"}
_TIME_AXES = {"time", "t", "ansi"}


def _exception(code: str, text: str, locator: str = "", status: int = 400) -> Response:
    loc = f' locator="{escape(locator)}"' if locator else ""
    body = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<ows:ExceptionReport {NS} version="{WCS_VERSION}">'
        f'<ows:Exception exceptionCode="{escape(code)}"{loc}>'
        f"<ows:ExceptionText>{escape(text)}</ows:ExceptionText>"
        f"</ows:Exception></ows:ExceptionReport>"
    )
    return Response(content=body, media_type=XML_MIME, status_code=status)


def _parse_subsets(raw: list[str]) -> dict[str, tuple[str, str | None]]:
    """Turn repeated `subset=Axis(low,high)` into {axis_lower: (low, high)}."""
    out: dict[str, tuple[str, str | None]] = {}
    for item in raw:
        m = _SUBSET.match(item.strip())
        if not m:
            raise ValueError(f"malformed subset {item!r}; expected Axis(low,high)")
        low = m.group("low").strip().strip('"')
        high = m.group("high")
        out[m.group("axis").lower()] = (low, high.strip().strip('"') if high else None)
    return out


def _num(v: str, what: str) -> float:
    try:
        return float(v)
    except ValueError as exc:
        raise ValueError(f"{what} bound {v!r} is not a number") from exc


def _capabilities(store: DataStore, base: str) -> Response:
    summaries = []
    for key in sorted(store.all_variables()):
        cfd = store.dataset_for(key)
        cv = cfd.meta(key)
        bb = cfd.bbox()
        summaries.append(
            f"<wcs:CoverageSummary>"
            f"<wcs:CoverageId>{escape(key)}</wcs:CoverageId>"
            f"<wcs:CoverageSubtype>RectifiedGridCoverage</wcs:CoverageSubtype>"
            f"<ows:Title>{escape(cv.long_name)}</ows:Title>"
            f'<ows:WGS84BoundingBox crs="urn:ogc:def:crs:OGC::CRS84">'
            f"<ows:LowerCorner>{bb.west} {bb.south}</ows:LowerCorner>"
            f"<ows:UpperCorner>{bb.east} {bb.north}</ows:UpperCorner>"
            f"</ows:WGS84BoundingBox>"
            f"</wcs:CoverageSummary>"
        )

    def op(name: str) -> str:
        return (
            f'<ows:Operation name="{name}"><ows:DCP><ows:HTTP>'
            f'<ows:Get xlink:href="{escape(base)}?"/>'
            f"</ows:HTTP></ows:DCP></ows:Operation>"
        )

    body = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<wcs:Capabilities {NS} version="{WCS_VERSION}">'
        f"<ows:ServiceIdentification>"
        f"<ows:Title>oceanUps coverages</ows:Title>"
        f"<ows:Abstract>Ocean model fields for the Indian EEZ, served as "
        f"CF-{CF_CONVENTIONS.split('-')[-1]} NetCDF coverages. "
        f"WCS 2.0.1 core profile: trimming subsets only.</ows:Abstract>"
        f"<ows:ServiceType>OGC WCS</ows:ServiceType>"
        f"<ows:ServiceTypeVersion>{WCS_VERSION}</ows:ServiceTypeVersion>"
        f"<ows:Fees>NONE</ows:Fees><ows:AccessConstraints>NONE</ows:AccessConstraints>"
        f"</ows:ServiceIdentification>"
        f"<ows:OperationsMetadata>"
        f"{op('GetCapabilities')}{op('DescribeCoverage')}{op('GetCoverage')}"
        f"</ows:OperationsMetadata>"
        f"<wcs:ServiceMetadata>"
        f"<wcs:formatSupported>{NETCDF_MIME}</wcs:formatSupported>"
        f"</wcs:ServiceMetadata>"
        f"<wcs:Contents>{''.join(summaries)}</wcs:Contents>"
        f"</wcs:Capabilities>"
    )
    return Response(content=body, media_type=XML_MIME)


def _describe(store: DataStore, ids: list[str]) -> Response:
    descriptions = []
    for key in ids:
        if key not in store.all_variables():
            return _exception("NoSuchCoverage", f"no coverage {key!r}", "coverageId", 404)
        cfd = store.dataset_for(key)
        cv = cfd.meta(key)
        lats, lons, depths = cfd.lats, cfd.lons, cfd.depths
        times = cfd.time_strings()
        low = f"{lats[0]} {lons[0]}"
        high = f"{lats[-1]} {lons[-1]}"
        grid_high = f"{len(lats) - 1} {len(lons) - 1}"
        # Offset vectors describe a rectified grid; ours is regular in both
        # horizontal axes, which is exactly the case WCS 2.0 covers cleanly.
        dlat = (lats[-1] - lats[0]) / max(len(lats) - 1, 1)
        dlon = (lons[-1] - lons[0]) / max(len(lons) - 1, 1)
        descriptions.append(
            f'<wcs:CoverageDescription gml:id="{escape(key)}">'
            f"<gml:boundedBy>"
            f'<gml:Envelope axisLabels="Lat Long" srsDimension="2" '
            f'srsName="http://www.opengis.net/def/crs/OGC/1.3/CRS84">'
            f"<gml:lowerCorner>{low}</gml:lowerCorner>"
            f"<gml:upperCorner>{high}</gml:upperCorner>"
            f"</gml:Envelope></gml:boundedBy>"
            f"<wcs:CoverageId>{escape(key)}</wcs:CoverageId>"
            f"<gml:domainSet>"
            f'<gml:RectifiedGrid dimension="2" gml:id="grid-{escape(key)}">'
            f'<gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low>'
            f"<gml:high>{grid_high}</gml:high></gml:GridEnvelope></gml:limits>"
            f"<gml:axisLabels>Lat Long</gml:axisLabels>"
            f'<gml:origin><gml:Point gml:id="origin-{escape(key)}" '
            f'srsName="http://www.opengis.net/def/crs/OGC/1.3/CRS84">'
            f"<gml:pos>{low}</gml:pos></gml:Point></gml:origin>"
            f"<gml:offsetVector>{dlat} 0</gml:offsetVector>"
            f"<gml:offsetVector>0 {dlon}</gml:offsetVector>"
            f"</gml:RectifiedGrid></gml:domainSet>"
            f"<gmlcov:rangeType><swe:DataRecord>"
            f'<swe:field name="{escape(key)}">'
            f'<swe:Quantity definition="{escape(cv.standard_name)}">'
            f"<swe:description>{escape(cv.long_name)}</swe:description>"
            f'<swe:uom code="{escape(cv.units)}"/>'
            f"<swe:constraint><swe:AllowedValues><swe:interval>"
            f"{cv.valid[0]} {cv.valid[1]}"
            f"</swe:interval></swe:AllowedValues></swe:constraint>"
            f"</swe:Quantity></swe:field>"
            f"</swe:DataRecord></gmlcov:rangeType>"
            f"<wcs:ServiceParameters>"
            f"<wcs:CoverageSubtype>RectifiedGridCoverage</wcs:CoverageSubtype>"
            f"<wcs:nativeFormat>{NETCDF_MIME}</wcs:nativeFormat>"
            f"</wcs:ServiceParameters>"
            # Depth and time are real axes of this coverage even though the
            # core profile advertises the grid as 2D; saying so here is what
            # lets a client know a depth/time subset is meaningful.
            f"<!-- depth levels: {len(depths)} ({depths[0]:.1f}..{depths[-1]:.1f} m); "
            f"time steps: {len(times)}"
            + (f" ({times[0]}..{times[-1]})" if times else "")
            + " -->"
            f"</wcs:CoverageDescription>"
        )
    body = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<wcs:CoverageDescriptions {NS} version="{WCS_VERSION}">'
        f"{''.join(descriptions)}</wcs:CoverageDescriptions>"
    )
    return Response(content=body, media_type=XML_MIME)


def _get_coverage(store: DataStore, key: str, subsets: dict[str, tuple[str, str | None]]):
    cfd = store.dataset_for(key)
    cv = cfd.meta(key)
    full = cfd.bbox()

    west, east = full.west, full.east
    south, north = full.south, full.north
    for axis, (lo, hi) in subsets.items():
        if axis in _LON_AXES:
            west = _num(lo, "Long")
            east = _num(hi, "Long") if hi is not None else west
        elif axis in _LAT_AXES:
            south = _num(lo, "Lat")
            north = _num(hi, "Lat") if hi is not None else south

    depth_range: DepthRange | None = None
    depth_point: float | None = None
    for axis, (lo, hi) in subsets.items():
        if axis in _DEPTH_AXES:
            if hi is None:
                depth_point = _num(lo, "depth")
            else:
                depth_range = DepthRange(_num(lo, "depth"), _num(hi, "depth"))

    time_iso: str | None = None
    for axis, (lo, _hi) in subsets.items():
        if axis in _TIME_AXES:
            time_iso = lo

    values, coords = cfd.select(
        key,
        bbox=BBox(west, south, east, north),
        time=time_iso,
        depth=depth_point,
        depth_range=depth_range if depth_point is None else None,
    )
    if values.size == 0:
        raise ValueError("the requested subset is empty; check the axis order and bounds")

    stamp = time_iso or (cfd.time_strings() or [None])[0]
    da = xr.DataArray(
        values.astype("float32"),
        dims=("depth", "lat", "lon"),
        coords={
            "depth": np.asarray(coords["depth"], dtype="float32"),
            "lat": np.asarray(coords["lat"], dtype="float32"),
            "lon": np.asarray(coords["lon"], dtype="float32"),
        },
        name=key,
        attrs={
            "standard_name": cv.standard_name,
            "long_name": cv.long_name,
            "units": cv.units,
        },
    )
    da["depth"].attrs.update(
        {"units": "m", "positive": "down", "axis": "Z", "standard_name": "depth"}
    )
    da["lat"].attrs.update(
        {"units": "degrees_north", "axis": "Y", "standard_name": "latitude"}
    )
    da["lon"].attrs.update(
        {"units": "degrees_east", "axis": "X", "standard_name": "longitude"}
    )
    ds = da.to_dataset()
    ds.attrs = {
        "Conventions": CF_CONVENTIONS,
        "title": f"{cv.long_name} -- WCS GetCoverage subset",
        "source": cfd.source,
        "synthetic": "true" if cfd.synthetic else "false",
        "history": f"oceanUps WCS {WCS_VERSION} GetCoverage; time={stamp}",
    }

    buf = io.BytesIO()
    # scipy writes NetCDF-3 to a file object without needing a real path,
    # which h5netcdf cannot do. Callers open it through core.netcdf anyway.
    ds.to_netcdf(buf, engine="scipy")
    return Response(
        content=buf.getvalue(),
        media_type=NETCDF_MIME,
        headers={
            "Content-Disposition": f'attachment; filename="{key}_wcs.nc"',
            "X-Coverage-Shape": "x".join(str(n) for n in values.shape),
        },
    )


@router.get("/wcs")
def wcs(
    request: Request,
    service: str = Query("WCS"),
    version: str = Query(WCS_VERSION),
    store: DataStore = Depends(get_store),
):
    """OGC WCS 2.0.1 core profile, KVP encoding.

    Parameters are read off the raw query string rather than declared: WCS
    repeats `subset` and is case-insensitive in its keys, and FastAPI's
    signature-based parsing models neither.
    """
    params = {k.lower(): v for k, v in request.query_params.items()}
    op = params.get("request", "").strip()

    if service and service.upper() not in ("WCS", ""):
        return _exception("InvalidParameterValue", f"service must be WCS, got {service!r}", "service")

    if op.lower() == "getcapabilities":
        base = str(request.url.replace(query=""))
        return _capabilities(store, base)

    if version and not version.startswith("2.0"):
        return _exception(
            "VersionNegotiationFailed", f"only {WCS_VERSION} is served", "version"
        )

    ids = [c for c in request.query_params.getlist("coverageId") if c] or [
        c for c in request.query_params.getlist("coverageid") if c
    ]

    if op.lower() == "describecoverage":
        if not ids:
            return _exception("MissingParameterValue", "coverageId is required", "coverageId")
        return _describe(store, ids)

    if op.lower() == "getcoverage":
        if not ids:
            return _exception("MissingParameterValue", "coverageId is required", "coverageId")
        key = ids[0]
        if key not in store.all_variables():
            return _exception("NoSuchCoverage", f"no coverage {key!r}", "coverageId", 404)
        fmt = params.get("format", NETCDF_MIME)
        if fmt not in (NETCDF_MIME, "netcdf", "application/netcdf"):
            return _exception(
                "InvalidParameterValue", f"only {NETCDF_MIME} is served, got {fmt!r}", "format"
            )
        try:
            subsets = _parse_subsets(request.query_params.getlist("subset"))
            return _get_coverage(store, key, subsets)
        except ValueError as exc:
            return _exception("InvalidSubsetting", str(exc), "subset")
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("WCS GetCoverage failed")
            return _exception("NoApplicableCode", str(exc), "", 500)

    return _exception(
        "OperationNotSupported",
        "request must be GetCapabilities, DescribeCoverage or GetCoverage",
        "request",
    )
