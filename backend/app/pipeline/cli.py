"""Data pipeline CLI.

    python -m app.pipeline.cli synth  --profile demo
    python -m app.pipeline.cli verify --catalog config/catalog.synthetic.yaml
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


if __name__ == "__main__":
    app()
