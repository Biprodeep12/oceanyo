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


def _model_window(catalog: Path | None) -> tuple[str | None, str | None]:
    """First and last day of the configured model's time axis, as ISO days."""
    try:
        from ..core.catalog import Catalog
        from ..core.cf_adapter import CFDataset

        entry = Catalog.load(catalog)
        cfd = CFDataset.open(
            entry.model.uri,
            source=entry.source,
            synthetic=entry.synthetic,
            var_map=entry.model.variables,
            engine=entry.model.engine,
            load=False,
        )
        steps = cfd.time_strings()
        cfd.ds.close()
        if not steps:
            return None, None
        return steps[0][:10], steps[-1][:10]
    except Exception as exc:  # a missing model must not block the Argo fetch
        logging.getLogger("fetch-real").warning("cannot read the model time axis: %s", exc)
        return None, None


@app.command("fetch-real")
def fetch_real(
    out: Path = typer.Option(None, help="output directory (default data/real/argo)"),
    want: int = typer.Option(6, help="how many floats to keep"),
    scan: int = typer.Option(40, help="how many floats to examine"),
    dac: str = typer.Option("incois", help="Argo DAC to draw from"),
    gliders: int = typer.Option(
        3,
        help="how many EGO glider deployments to fetch (0 to skip)",
    ),
    catalog: Path = typer.Option(
        None,
        help="catalog whose model time axis bounds the glider search "
        "(default: the configured one)",
    ),
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
    #
    # A glider only earns its place in this platform if it can be COMPARED to
    # the model, and that needs the two to overlap in time. So the search
    # window is read from the model's own axis rather than picked: point this
    # at a different catalog and the deployments it fetches move with it.
    from .fetch_real import fetch_glider

    since, until = _model_window(catalog)
    if since:
        log.info("")
        log.info("model record runs %s .. %s", since, until)
    else:
        log.warning("")
        log.warning("no model time axis available; selecting gliders on position alone")

    gdir = outdir.parent / "glider"
    paths, summary = fetch_glider(gdir, since=since, until=until, want=gliders)
    log.info("")
    log.info("REAL GLIDERS: EGO trajectory index")
    log.info("  deployments in the index      %d", summary["deployments_in_index"])
    log.info("  candidates in the Indian Ocean %d", summary["candidates_in_bbox"])
    if since:
        log.info("  ruled out by the model window %d", summary["rejected_window"])
    for bad in summary["rejected_position"]:
        # Worth printing: the index said one place, the file says another.
        log.warning(
            "  index position wrong for %s: index %s, file lat %.2f..%.2f lon %.2f..%.2f",
            bad["file"], bad["index"], *bad["actual"],
        )
    for bad in summary["rejected_time"]:
        log.warning(
            "  index dates wrong for %s: index %s, file %s",
            bad["file"], bad["index"], bad["actual"],
        )
    for name, size in summary["skipped_too_large"]:
        log.info("  skipped %s (%.1f MB)", name, size / 1e6)
    for good in summary["kept"]:
        days = good.get("days")
        log.info("  keeping %s  %s", good["file"], f"{days[0]} .. {days[1]}" if days else "")

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

@app.command("fetch-hycom")
def fetch_hycom_cmd(
    out: Path = typer.Option(None, help="raw chunk directory (default data/raw/hycom)"),
    dest: Path = typer.Option(None, help="merged output (default data/real/hycom_bob_<start>.nc)"),
    start: str = typer.Option("2024-01-01", help="first day, ISO"),
    days: int = typer.Option(30, help="how many days the window spans"),
    step_days: int = typer.Option(3, help="days between timesteps"),
    west: float = typer.Option(80.0), south: float = typer.Option(5.0),
    east: float = typer.Option(95.0), north: float = typer.Option(22.0),
    horiz_stride: int = typer.Option(1, help="1 = native 1/12 degree"),
) -> None:
    """Download a REAL 1/12 degree model subset from HYCOM. No account needed.

    Resumable: chunks already on disk are kept, so a re-run after a dropped
    connection costs only what is missing.
    """
    _setup_logging()
    from .fetch_hycom import build_model, fetch_hycom

    outdir = out or (REPO_ROOT / "data" / "raw" / "hycom")
    target = dest or (REPO_ROOT / "data" / "real" / f"hycom_bob_{start[:7]}.nc")

    log.info("HYCOM GOFS 3.1 -> %s", outdir)
    log.info("  %s for %d days, every %d day(s), bbox %g %g %g %g",
             start, days, step_days, west, south, east, north)
    chunks = fetch_hycom(
        outdir, bbox=(west, south, east, north), start=start, days=days,
        step_days=step_days, horiz_stride=horiz_stride,
    )
    total = sum(p.stat().st_size for ps in chunks.values() for p in ps)
    log.info("  %d chunks, %.0f MB raw", sum(len(v) for v in chunks.values()), total / 1e6)

    path = build_model(chunks, target)
    from ..core.netcdf import open_dataset

    ds = open_dataset(path)
    log.info("")
    log.info("REAL MODEL: %s", path.name)
    log.info("  grid       %s", dict(ds.sizes))
    log.info("  variables  %s", list(ds.data_vars))
    log.info("  point OCEANUPS_CATALOG at config/catalog.hycom.yaml to use it")
    ds.close()


@app.command("fetch-erddap")
def fetch_erddap_cmd(
    out: Path = typer.Option(None, help="output directory (default data/real)"),
    start: str = typer.Option("2024-01-01", help="first day of chlorophyll, ISO"),
    end: str = typer.Option("2024-01-30", help="last day of chlorophyll, ISO"),
    stride: int = typer.Option(2, help="bathymetry decimation; 2 = 30 arc-second"),
    west: float = typer.Option(80.0), south: float = typer.Option(5.0),
    east: float = typer.Option(95.0), north: float = typer.Option(22.0),
) -> None:
    """Download REAL chlorophyll and bathymetry from NOAA ERDDAP. No account."""
    _setup_logging()
    from .fetch_erddap import fetch_bathymetry, fetch_chlorophyll, repair_cf
    from ..core.netcdf import open_dataset

    outdir = out or (REPO_ROOT / "data" / "real")
    bbox = (west, south, east, north)

    log.info("ERDDAP -> %s", outdir)
    log.info("  bathymetry: NOAA NCEI ETOPO 2022")
    bathy = repair_cf(fetch_bathymetry(outdir, bbox=bbox, stride=stride))
    log.info("  chlorophyll: VIIRS SNPP+NOAA-20, DINEOF gap-filled")
    chl = repair_cf(fetch_chlorophyll(outdir, bbox=bbox, start=start, end=end))

    for path in (bathy, chl):
        ds = open_dataset(path)
        log.info("  %-34s %s  %.1f MB", path.name, dict(ds.sizes),
                 path.stat().st_size / 1e6)
        ds.close()


if __name__ == "__main__":
    app()
