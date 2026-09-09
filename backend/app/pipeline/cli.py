"""Data pipeline CLI.

    python -m app.pipeline.cli synth      --profile demo
    python -m app.pipeline.cli verify     --catalog config/catalog.synthetic.yaml
    python -m app.pipeline.cli fetch-real --want 6
"""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

import typer

from ..core.config import REPO_ROOT, settings

app = typer.Typer(add_completion=False, help="oceanUps data pipeline")


def _setup_logging(verbose: bool = True) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )


@app.command()
def synth(
    profile: str = typer.Option("demo", help="tiny | demo | full"),
    out: Path = typer.Option(None, help="output directory"),
    seed: int = typer.Option(7, help="RNG seed for bathymetry and observation noise"),
    skip_model: bool = typer.Option(False, "--skip-model"),
    skip_obs: bool = typer.Option(False, "--skip-obs"),
) -> None:
    """Generate the synthetic ocean dataset."""
    _setup_logging()
    from .synth import writer
    from .synth.grid import PROFILES

    if profile not in PROFILES:
        raise typer.BadParameter(f"unknown profile {profile!r}; choose from {list(PROFILES)}")
    gp = PROFILES[profile]
    outdir = Path(out) if out else (REPO_ROOT / "data" / "synthetic")
    outdir.mkdir(parents=True, exist_ok=True)

    log = logging.getLogger("synth")
    log.info("profile=%s bbox=[%s, %s, %s, %s] res=%s levels=%d steps=%d",
             gp.name, gp.west, gp.south, gp.east, gp.north,
             gp.resolution, gp.n_levels, gp.n_steps)

    t0 = time.time()
    writer.write_bathymetry(gp, outdir / "gebco.nc", seed=seed)
    if not skip_model:
        writer.write_model(gp, outdir / "model.nc", seed=seed)
        writer.write_bgc(gp, outdir / "bgc.nc")
        writer.write_climatology(gp, outdir / "climatology.nc")
    if not skip_obs:
        from .synth import argo, glider

        argo.write_floats(gp, outdir / "argo", seed=seed)
        glider.write_deployments(gp, outdir / "glider", seed=seed)
    log.info("done in %.1fs -> %s", time.time() - t0, outdir)


@app.command()
def verify(
    catalog: Path = typer.Option(None, help="catalog YAML (defaults to OCEANUPS_CATALOG)"),
) -> None:
    """Assert the configured dataset satisfies the platform's data contract."""
    _setup_logging()
    from .verify.contract import run_contract

    ok = run_contract(catalog or settings.catalog)
    raise typer.Exit(code=0 if ok else 1)


@app.command("fetch-real")
def fetch_real(
    out: Path = typer.Option(None, help="output directory (default data/real/argo)"),
    want: int = typer.Option(6, help="how many floats to keep"),
    scan: int = typer.Option(40, help="how many floats to examine"),
    dac: str = typer.Option("incois", help="Argo DAC to draw from"),
    gliders: bool = typer.Option(True, help="also fetch an EGO glider deployment"),
    woa: bool = typer.Option(
        False,
        help="also fetch NOAA WOA23 and build a real climatology (~160 MB)",
    ),
) -> None:
    """Download real Argo and glider data from the Ifremer GDACs and parse it.

    Proves the claim the rest of the project rests on: that the same parser
    reads synthetic and real files. It downloads a few hundred kilobytes from
    the public GDAC -- no credentials -- and then runs the registered parser
    over what it fetched, reporting profiles loaded and the QC histogram.

    GLORYS12 and the Copernicus BGC reanalysis need a free Copernicus account
    and the `copernicusmarine` toolbox; those commands are in the README,
    because a credentialed download cannot be part of an offline demo.
    """
    _setup_logging()
    log = logging.getLogger("fetch-real")
    from ..api.obs.registry import REGISTRY, load_builtin_parsers
    from .fetch_real import USER_AGENT, fetch_argo

    outdir = Path(out) if out else (REPO_ROOT / "data" / "real" / "argo")
    kept = fetch_argo(outdir, want=want, scan=scan, dac=dac)
    if not kept:
        log.error("no floats matched; nothing to verify")
        raise typer.Exit(code=1)

    load_builtin_parsers()
    parser = REGISTRY.get("argo_netcdf")
    refs = parser.discover(outdir, None, None, None)

    import collections

    flags: collections.Counter[int] = collections.Counter()
    loaded = failed = levels = 0
    for ref in refs:
        try:
            profile = parser.load(ref)
        except Exception as exc:
            failed += 1
            log.warning("%s failed to parse: %s", ref.id, exc)
            continue
        loaded += 1
        temp = profile.variables.get("temperature")
        if temp:
            levels += len(temp.values)
            flags.update(temp.qc)

    log.info("")
    log.info("REAL ARGO: %d files from the %s DAC", len(kept), dac)
    log.info("  profiles parsed  %d ok, %d failed", loaded, failed)
    log.info("  temperature levels %d", levels)
    log.info("  QC histogram %s", dict(sorted(flags.items())))

    if not gliders:
        raise typer.Exit(code=0 if failed == 0 else 1)

    # --- gliders -------------------------------------------------------
    from .fetch_real import fetch_glider

    gdir = outdir.parent / "glider"
    paths, summary = fetch_glider(gdir, want=1)
    log.info("")
    log.info("REAL GLIDERS: EGO trajectory index")
    log.info("  deployments in the index      %d", summary["deployments_in_index"])
    log.info("  candidates in the Indian Ocean %d", summary["candidates_in_bbox"])
    for bad in summary["rejected_position"]:
        # Worth printing: the index said one place, the file says another.
        log.warning(
            "  index position wrong for %s: index %s, file lat %.2f..%.2f lon %.2f..%.2f",
            bad["file"], bad["index"], *bad["actual"],
        )
    for name, size in summary["skipped_too_large"]:
        log.info("  skipped %s (%.1f MB)", name, size / 1e6)

    if not paths:
        log.warning("  no deployment downloaded; the glider check is skipped")
        raise typer.Exit(code=0 if failed == 0 else 1)

    gparser = REGISTRY.get("glider_ego")
    grefs = gparser.discover(gdir, None, None, None)
    gflags: collections.Counter[int] = collections.Counter()
    gok = gbad = 0
    deepest = 0.0
    for ref in grefs:
        try:
            prof = gparser.load(ref)
        except Exception as exc:
            gbad += 1
            log.warning("  %s failed to parse: %s", ref.id, exc)
            continue
        gok += 1
        if prof.depth:
            deepest = max(deepest, prof.depth[-1])
        temp = prof.variables.get("temperature")
        if temp:
            gflags.update(temp.qc)
    log.info("  dives/climbs segmented        %d", len(grefs))
    log.info("  profiles parsed               %d ok, %d failed", gok, gbad)
    log.info("  deepest profile               %.0f m", deepest)
    log.info("  QC histogram                  %s", dict(sorted(gflags.items())))

    if not woa:
        raise typer.Exit(code=0 if failed == 0 and gbad == 0 else 1)

    # --- in-situ climatology (problem statement item d) -----------------
    #
    # WOA is the World Ocean Database objectively analysed onto a grid, so it
    # IS the collection of in-situ data. It is also 1 degree against a 1/12
    # degree model, which is exactly why the anomaly service interpolates the
    # climatology onto the model grid rather than requiring a match.
    import urllib.request as _urlreq

    from .fetch_real import build_woa_climatology, woa_url

    wdir = outdir.parent / "woa"
    wdir.mkdir(parents=True, exist_ok=True)
    sources: dict[str, Path] = {}
    for variable in ("temperature", "salinity"):
        url = woa_url(variable)
        dest = wdir / url.rsplit("/", 1)[-1]
        if not dest.exists():
            log.info("  downloading %s (~85 MB)", dest.name)
            req = _urlreq.Request(url, headers={"User-Agent": USER_AGENT})
            with _urlreq.urlopen(req, timeout=900) as resp:
                dest.write_bytes(resp.read())
        sources[variable] = dest

    clim = build_woa_climatology(sources, outdir.parent / "climatology_woa23_bob.nc")
    log.info("")
    log.info("REAL CLIMATOLOGY: NOAA WOA23 (decav, 1.00 deg)")
    log.info("  wrote %s (%.1f MB)", clim.name, clim.stat().st_size / 1e6)
    log.info("  point catalog.glorys.yaml `climatology.uri` at it to use it")

    raise typer.Exit(code=0 if failed == 0 and gbad == 0 else 1)


if __name__ == "__main__":
    app()
