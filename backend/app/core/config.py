"""Runtime settings. The catalog path is the single swap surface."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OCEANUPS_", env_file=".env", extra="ignore")

    # Swap synthetic -> real by pointing this at config/catalog.glorys.yaml.
    # Nothing else changes.
    catalog: Path = REPO_ROOT / "config" / "catalog.synthetic.yaml"
    data_root: Path = REPO_ROOT / "data"
    cache_dir: Path = REPO_ROOT / "data" / "cache"

    # xpublish is the flakiest dependency in the stack; it is mounted inside a
    # try/except and the API boots regardless. See api/main.py.
    enable_xpublish: bool = True

    max_volume_bytes: int = 8 * 1024 * 1024
    cache_max_bytes: int = 512 * 1024 * 1024

    def resolve(self, p: str | Path) -> Path:
        p = Path(p)
        return p if p.is_absolute() else (REPO_ROOT / p)


settings = Settings()
