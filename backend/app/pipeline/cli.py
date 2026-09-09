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
) -> None:
    """Download real Argo profiles from the Ifremer GDAC and parse them.

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
    from .fetch_real import fetch_argo

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
    log.info("REAL DATA: %d files from the %s DAC", len(kept), dac)
    log.info("  profiles parsed  %d ok, %d failed", loaded, failed)
    log.info("  temperature levels %d", levels)
    log.info("  QC histogram %s", dict(sorted(flags.items())))
    raise typer.Exit(code=0 if failed == 0 else 1)


if __name__ == "__main__":
    app()
