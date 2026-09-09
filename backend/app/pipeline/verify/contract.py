"""Data contract assertions.

Runs against WHICHEVER catalog is configured, so the same suite that proves the
synthetic dataset is sound is the first thing run against real GLORYS12 data
after a swap. That is what makes the swap a config change rather than an act of
faith.

Every check here exists because something can plausibly go wrong with it. The
monotonic-axis check in particular was added after a non-monotonic depth axis
silently broke every xarray .sel() downstream.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from ...core.catalog import Catalog
from ...core.cf_adapter import CFDataset
from ...core.geometry import BBox, DepthRange

log = logging.getLogger("verify")


class Checker:
    def __init__(self) -> None:
        self.passed = 0
        self.failed: list[str] = []

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        if ok:
            self.passed += 1
            log.info("  PASS  %s%s", label, f"  ({detail})" if detail else "")
        else:
            self.failed.append(label)
            log.error("  FAIL  %s%s", label, f"  ({detail})" if detail else "")
        return ok


def _check_grid(c: Checker, cfd: CFDataset, name: str, *, require_depth: bool) -> None:
    log.info("[%s] %s", name, cfd.uri)

    c.check(cfd.axes.lon is not None and cfd.axes.lat is not None,
            f"{name}: lon/lat axes detected",
            f"lon={cfd.axes.lon} lat={cfd.axes.lat}")

    if require_depth:
        c.check(cfd.axes.depth is not None, f"{name}: vertical axis detected",
                str(cfd.axes.depth))
        c.check(cfd.axes.positive_down, f"{name}: depth is positive DOWN")

    c.check(cfd.axes.time is not None, f"{name}: time axis detected", str(cfd.axes.time))

    # Monotonic axes. A non-monotonic index makes every .sel() with a slice or
    # method="nearest" fail at request time rather than at load time.
    for axis_name, vals in (("lon", cfd.lons), ("lat", cfd.lats)):
        c.check(bool(np.all(np.diff(vals) > 0)) or bool(np.all(np.diff(vals) < 0)),
                f"{name}: {axis_name} axis is monotonic", f"{len(vals)} points")
    if require_depth and cfd.axes.depth is not None:
        d = cfd.depths
        c.check(bool(np.all(np.diff(d) > 0)),
                f"{name}: depth axis strictly increasing",
                f"{d[0]:.3f} .. {d[-1]:.1f} m, {len(d)} levels")

    times = cfd.time_strings()
    c.check(len(times) > 0, f"{name}: time axis parses", f"{len(times)} steps")


def run_contract(catalog_path: Path) -> bool:
    cat = Catalog.load(catalog_path)
    c = Checker()

    log.info("catalog %s  (synthetic=%s)", cat.id, cat.synthetic)
    log.info("source   %s", cat.source)
    log.info("")

    # --- model ---
    model = CFDataset.open(
        cat.model.uri, source=cat.source, synthetic=cat.synthetic,
        var_map=cat.model.variables, engine=cat.model.engine,
    )
    _check_grid(c, model, "model", require_depth=True)

    have = model.canonical_vars()
    for required in ("temperature", "salinity", "u", "v"):
        c.check(required in have, f"model: {required} resolvable",
                f"-> {model.raw_name(required)}" if required in have else "MISSING")

    # Argo profiles to 2000 m: a shallower model subset leaves every deeper
    # matchup with nothing to compare against.
    dr = model.depth_range()
    c.check(dr.bottom >= 1900.0, "model: depth reaches ~2000 m for Argo matchups",
            f"max {dr.bottom:.0f} m")

    # --- dtype and select() contract ---
    box = cat.default_bbox.clamp_to(model.bbox())
    vals, coords = model.select("temperature", bbox=box,
                                depth_range=DepthRange(0, min(2000, dr.bottom)))
    c.check(vals.dtype == np.float32, "select: returns float32", str(vals.dtype))
    c.check(vals.ndim == 3, "select: returns 3 dims (depth, lat, lon)", str(vals.shape))
    c.check(bool(np.all(np.diff(coords["depth"]) > 0)), "select: depth ascending downward")
    c.check(bool(np.all(np.diff(coords["lat"]) > 0)), "select: lat ascending north")
    c.check(bool(np.all(np.diff(coords["lon"]) > 0)), "select: lon ascending east")
    c.check(bool(np.isfinite(vals).any()), "select: returns some finite data")
    c.check(bool(np.isnan(vals).any()), "select: land/seabed is NaN-masked",
            f"{np.isnan(vals).mean():.1%} of cells")

    # --- quantization round trip ---
    from ...api.services.volume import dequantize, quantize

    sample = vals[:, : min(8, vals.shape[1]), : min(8, vals.shape[2])]
    q = quantize(sample, vmin=-2.0, vmax=36.0)
    raw = np.frombuffer(q.raw, dtype=np.uint8).reshape(sample.shape)
    back = dequantize(raw, q.scale, q.offset)
    both = np.isfinite(sample) & np.isfinite(back)
    err = float(np.max(np.abs(sample[both] - back[both]))) if both.any() else 0.0
    c.check(err <= q.scale, "quantize: round trip within one quantum",
            f"max err {err:.5f} <= scale {q.scale:.5f}")
    c.check(bool((raw[np.isnan(sample)] == 0).all()) if np.isnan(sample).any() else True,
            "quantize: fill maps to reserved raw 0")

    # --- optional products ---
    if cat.bathymetry is not None:
        try:
            bathy = CFDataset.open(cat.bathymetry.uri, source=cat.source,
                                   synthetic=cat.synthetic, engine=cat.bathymetry.engine)
            c.check("elevation" in bathy.ds, "bathymetry: elevation present")
            elev = np.asarray(bathy.ds["elevation"].values)
            c.check(float(np.nanmin(elev)) < 0, "bathymetry: has water below sea level",
                    f"min {np.nanmin(elev):.0f} m")
        except Exception as exc:
            c.check(False, "bathymetry: opens", str(exc))

    if cat.bgc is not None:
        try:
            bgc = CFDataset.open(cat.bgc.uri, source=cat.source, synthetic=cat.synthetic,
                                 var_map=cat.bgc.variables, engine=cat.bgc.engine)
            c.check("chlorophyll" in bgc.canonical_vars(), "bgc: chlorophyll resolvable")
        except Exception as exc:
            c.check(False, "bgc: opens", str(exc))

    # --- observations ---
    from ...api.obs.registry import REGISTRY, load_builtin_parsers

    load_builtin_parsers()
    for src in cat.observations:
        try:
            parser = REGISTRY.get(src.parser)
        except KeyError as exc:
            c.check(False, f"obs: parser {src.parser!r} registered", str(exc))
            continue
        refs = parser.discover(Path(src.uri), BBox(*box.as_list()), None, None)
        c.check(len(refs) > 0, f"obs: {src.platform} has profiles in the demo bbox",
                f"{len(refs)} found")
        if refs:
            p = parser.load(refs[0])
            c.check(len(p.depth) > 0, f"obs: {src.platform} profile has levels",
                    f"{len(p.depth)} levels")
            c.check("temperature" in p.variables,
                    f"obs: {src.platform} profile carries temperature")

    # --- end-to-end: does the matchup recover the injected bias? ---
    #
    # The single most valuable check in the project, and it exists only because
    # the data is synthetic. Observations are the model field plus a KNOWN
    # offset, so `model - obs` must come back as minus that offset. It exercises
    # the whole chain at once: generator -> NetCDF -> CF adapter -> colocation
    # -> vertical interpolation -> statistics. It has already caught two real
    # bugs (a discontinuous thermocline, and field normalization that depended
    # on the extent of the array passed in rather than on the domain).
    if cat.synthetic:
        from ...api.services.matchup import summarize
        from ..synth.argo import INJECTED_BIAS

        argo_src = next((s for s in cat.observations if s.platform == "argo"), None)
        if argo_src is not None:
            parser = REGISTRY.get(argo_src.parser)
            refs = parser.discover(Path(argo_src.uri), None, None, None)[:40]
            profiles = [parser.load(r) for r in refs]
            for var, raw in (("temperature", "TEMP"), ("salinity", "PSAL")):
                expected = -INJECTED_BIAS[raw]  # bias is model - obs
                rows = summarize(model, profiles, variable=var)
                got = [r["bias"] for r in rows if r["bias"] is not None]
                if not got:
                    c.check(False, f"matchup: {var} produced any statistics")
                    continue
                mean_bias = float(np.mean(got))
                tol = 0.10 if var == "temperature" else 0.02
                c.check(
                    abs(mean_bias - expected) < tol,
                    f"matchup: recovers injected {var} bias",
                    f"got {mean_bias:+.4f}, expected {expected:+.3f} "
                    f"(tol {tol}), n={len(got)} profiles",
                )

    log.info("")
    total = c.passed + len(c.failed)
    if c.failed:
        log.error("CONTRACT FAILED: %d/%d passed. Failures:", c.passed, total)
        for f in c.failed:
            log.error("  - %s", f)
        return False
    log.info("CONTRACT PASSED: %d/%d checks", c.passed, total)
    return True
