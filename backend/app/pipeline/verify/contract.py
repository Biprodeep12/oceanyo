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

from ...api.datastore import resolve_bathymetry_var
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
            # GEBCO calls it `elevation`, ETOPO 2022 calls it `z`. The same
            # resolver the API uses, so the contract and the server cannot
            # disagree about which field is the seabed.
            bvar = resolve_bathymetry_var(bathy.ds, getattr(cat.bathymetry, "variable", None))
            c.check(bvar in bathy.ds, "bathymetry: elevation variable resolved", bvar)
            elev = np.asarray(bathy.ds[bvar].values)
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
        if refs:
            c.check(True, f"obs: {src.platform} has profiles in the demo bbox",
                    f"{len(refs)} found")
        else:
            # A platform with data somewhere but none HERE is a fact about
            # ocean observing, not a defect. There is not one glider deployment
            # in the Bay of Bengal in the entire EGO GDAC -- 131 of 1115 are
            # Indian Ocean, nearly all Mozambique Channel -- so failing the
            # contract on it would mean the real catalog can never pass, and a
            # contract that cannot pass stops being read. What IS a defect is a
            # parser that finds nothing anywhere.
            anywhere = parser.discover(Path(src.uri), None, None, None)
            c.check(
                len(anywhere) > 0,
                f"obs: {src.platform} parser finds profiles",
                f"{len(anywhere)} outside the demo bbox, 0 inside"
                if anywhere
                else "none found at all",
            )
            if anywhere:
                log.warning(
                    "  NOTE  %s has %d profiles but none in the demo bbox",
                    src.platform, len(anywhere),
                )
            refs = anywhere
        if refs:
            p = parser.load(refs[0])
            c.check(len(p.depth) > 0, f"obs: {src.platform} profile has levels",
                    f"{len(p.depth)} levels")
            c.check("temperature" in p.variables,
                    f"obs: {src.platform} profile carries temperature")

    # --- instruments must not sample through the seafloor ---
    #
    # A float or glider drawn below the seabed is an obvious physical error in
    # the 3D view, and it is the kind of thing that regresses silently when the
    # bathymetry or the platform depths change.
    if cat.bathymetry is not None:
        try:
            bathy_ds = CFDataset.open(
                cat.bathymetry.uri, source=cat.source, synthetic=cat.synthetic,
                engine=cat.bathymetry.engine,
            )
            b_lons, b_lats = bathy_ds.lons, bathy_ds.lats
            b_var = resolve_bathymetry_var(
                bathy_ds.ds, getattr(cat.bathymetry, "variable", None)
            )
            b_elev = np.asarray(bathy_ds.ds[b_var].values, dtype=float)

            # Deepest water within ~0.1 degrees, not the single nearest cell.
            #
            # The question this check asks is "could an instrument at this
            # position have sampled this deep", and one cell of a 30 arc-second
            # grid cannot answer it on a continental slope, where the seabed
            # drops a kilometre inside two cells. A float's reported position is
            # its last GPS fix, not where the profile was taken; it drifts while
            # it ascends. Against synthetic data -- floats placed on the
            # synthetic seabed by construction -- one cell was exact and the
            # difference never showed. Against a real float over the real Indian
            # slope it flagged three perfectly good profiles.
            #
            # A profile is suspicious only if it is deeper than the deepest
            # water anywhere it could plausibly have been.
            pad = 0.1

            def _seabed(lon: float, lat: float) -> float:
                lo_i = int(np.clip(np.searchsorted(b_lats, lat - pad) - 1, 0, len(b_lats) - 1))
                hi_i = int(np.clip(np.searchsorted(b_lats, lat + pad) + 1, 1, len(b_lats)))
                lo_j = int(np.clip(np.searchsorted(b_lons, lon - pad) - 1, 0, len(b_lons) - 1))
                hi_j = int(np.clip(np.searchsorted(b_lons, lon + pad) + 1, 1, len(b_lons)))
                window = b_elev[lo_i:hi_i, lo_j:hi_j]
                if window.size == 0:
                    return float("inf")
                return float(-np.nanmin(window))

            offenders: list[str] = []
            checked = 0
            for src in cat.observations:
                try:
                    parser = REGISTRY.get(src.parser)
                except KeyError:
                    continue
                for ref in parser.discover(Path(src.uri), None, None, None):
                    try:
                        prof = parser.load(ref)
                    except Exception:
                        continue
                    depths = [
                        d
                        for d, v in zip(prof.depth, next(iter(prof.variables.values())).values)
                        if v is not None
                    ]
                    if not depths:
                        continue
                    checked += 1
                    floor = _seabed(prof.lon, prof.lat)
                    # Tolerance, and it is a physical quantity rather than a
                    # fudge: profile "depth" here IS pressure in decibars, which
                    # is how every profiling float reports and how the GDAC
                    # stores it. One decibar is about 0.99 m of seawater near
                    # the surface and rather less at depth, so reading dbar as
                    # metres OVERSTATES depth by 1-2% at 2000 m -- some 20-40 m.
                    # A real float that stopped 11 m "below" a 2121 m seabed is
                    # measuring correctly; the conversion we did not do is the
                    # error. Add the float's own position uncertainty and 2% is
                    # tight. A float 500 m below the seabed still fails.
                    if max(depths) > floor + max(50.0, 0.02 * floor):
                        offenders.append(f"{prof.platform}:{prof.id}")
            c.check(
                not offenders,
                "observations: none sample below the seabed",
                f"{checked} profiles checked"
                + (f"; offenders: {offenders[:3]}" if offenders else ""),
            )
        except Exception as exc:
            c.check(False, "observations: seabed consistency", str(exc))

    # --- section sampling orientation ---
    #
    # A transposed or vertically flipped section still returns entirely
    # plausible numbers -- warm at one end, cold at the other -- so the only
    # way to catch it is to compare against the gridded field at the SAME
    # coordinates. This is the section equivalent of the select() orientation
    # contract above.
    try:
        s_lons, s_lats = model.lons, model.lats
        pa = (float(s_lons[len(s_lons) // 4]), float(s_lats[len(s_lats) // 4]))
        pb = (float(s_lons[3 * len(s_lons) // 4]), float(s_lats[3 * len(s_lats) // 4]))
        sec, sec_depths = model.sample_track(
            "temperature",
            np.array([pa[0], pb[0]]),
            np.array([pa[1], pb[1]]),
            depth_range=DepthRange(0.0, 2000.0),
        )
        c.check(
            bool(np.all(np.diff(sec_depths) > 0)),
            "section: depth ascends downward",
            f"{sec_depths[0]:.2f} .. {sec_depths[-1]:.1f} m, {len(sec_depths)} levels",
        )
        c.check(
            sec.shape == (len(sec_depths), 2),
            "section: shaped (depth, along-track)",
            str(sec.shape),
        )
        ax = model.axes
        ref = model.ds[model.raw_name("temperature")]
        if ax.time is not None:
            ref = ref.isel({ax.time: 0})
        expect = float(
            ref.sel(
                {ax.lon: pa[0], ax.lat: pa[1], ax.depth: sec_depths[0]},
                method="nearest",
            ).values
        )
        got = float(sec[0, 0])
        c.check(
            abs(got - expect) < 1e-3,
            "section: agrees with the gridded field at the same point",
            f"section {got:.4f} vs grid {expect:.4f}",
        )
    except Exception as exc:
        c.check(False, "section: sampling", str(exc))

    # --- climatology anomaly ---
    #
    # The climatology is interpolated onto the model grid rather than required
    # to match it, because every real climatology is coarser than the model it
    # is compared against. A silent all-NaN result (a descending axis, a
    # missing level) would look exactly like "no anomaly anywhere".
    if cat.climatology is not None:
        try:
            from ...api.services.anomaly import anomaly_grid, available_variables

            clim = CFDataset.open(
                cat.climatology.uri, source=cat.source, synthetic=cat.synthetic,
                var_map=cat.climatology.variables, engine=cat.climatology.engine,
            )
            avail = available_variables(model, clim)
            c.check("temperature" in avail, "climatology: temperature anomaly available",
                    str(avail))
            if "temperature" in avail:
                g = anomaly_grid(
                    model, clim, variable="temperature", bbox=box, time=None, depth=0.0
                )
                finite = np.isfinite(g.z)
                c.check(bool(finite.any()), "anomaly: produces finite z-scores",
                        f"{finite.mean():.0%} of cells")
                sd = float(np.nanstd(g.z)) if finite.any() else 0.0
                c.check(sd > 0.05, "anomaly: has spatial structure, not a flat field",
                        f"sd {sd:.3f}")
        except Exception as exc:
            c.check(False, "climatology: anomaly", str(exc))

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
