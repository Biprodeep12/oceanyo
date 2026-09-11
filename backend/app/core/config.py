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

    # Where the running process may WRITE. Neither config/ nor data/ qualifies:
    # docker-compose bind-mounts both read-only. This holds the catalog chosen
    # from the UI, which is why it must be outside them both.
    runtime_dir: Path = REPO_ROOT / ".runtime"

    # How POST /api/catalog applies a change. "auto" reads OCEANUPS_SUPERVISED:
    #   exit -- something will restart us (compose's `restart:`, serve-api.mjs)
    #   off  -- nothing would bring the process back, so the endpoint refuses
    # Refusing is the point: an endpoint that can kill the server with no
    # supervisor is worse than no endpoint at all.
    restart_mode: str = "auto"
    #: Force the "exit" branch under a supervisor we cannot detect
    #: (systemd, pm2, a bare `docker run --restart`).
    supervised: bool = False

    # xpublish is the flakiest dependency in the stack; it is mounted inside a
    # try/except and the API boots regardless. See api/main.py.
    enable_xpublish: bool = True

    max_volume_bytes: int = 8 * 1024 * 1024
    cache_max_bytes: int = 512 * 1024 * 1024

    # --- natural-language query layer (spec 5.2) ---
    #
    # Optional in the strongest sense: with no key the palette still resolves
    # phrases against its own lookup table, which is the deterministic fallback
    # 5.2 requires. Nothing here can stop the platform booting.
    #
    # Any OpenAI-compatible endpoint works, which is what makes the provider
    # swappable rather than merely claimed: OpenRouter today, and an Ollama or
    # vLLM server at http://127.0.0.1:11434/v1 for the self-hosted deployment
    # 5.2 says production would need. A local base URL needs no key.
    nlq_enabled: bool = True
    nlq_base_url: str = "https://openrouter.ai/api/v1"
    # Free-tier model ids on OpenRouter are retired and renamed regularly. When
    # this one goes, /api/query reports the HTTP error and the model name, so
    # the fix is one environment variable rather than a debugging session.
    nlq_model: str = "nvidia/nemotron-3.5-lightning:free"
    nlq_api_key: str = ""
    # A TOTAL deadline, enforced in nlq.py -- not urlopen's timeout, which is
    # per socket operation and lets a slow trickle of bytes run for minutes.
    #
    # 25 s because a free tier's first call queues: measured 33 s cold and
    # 2.7-7 s warm on nvidia/nemotron-3.5-lightning:free. Anything tighter
    # would make the first query of a demo fail every time, which is the one
    # query most likely to be watched.
    nlq_timeout: float = 25.0

    def resolve(self, p: str | Path) -> Path:
        p = Path(p)
        return p if p.is_absolute() else (REPO_ROOT / p)


settings = Settings()
