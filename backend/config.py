"""Environment-driven configuration for the Cairn backend.

All settings come from the process environment (or a ``.env`` file at the
repo root). We use ``pydantic-settings`` so values are validated once at
startup instead of being scattered through ``os.getenv`` calls.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parent.parent
_ENV_FILE = _REPO_ROOT / ".env"


class Settings(BaseSettings):
    """Cairn runtime settings."""

    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---- Splunk MCP ----
    splunk_mcp_url: str = Field(
        default="https://localhost:8089/services/mcp/v1",
        description="Splunk MCP server endpoint.",
    )
    splunk_token: SecretStr = Field(
        default=SecretStr(""),
        description="Splunk auth token used to call the MCP server.",
    )

    # ---- Groq ----
    groq_api_key: SecretStr = Field(
        default=SecretStr(""),
        description="Groq API key.",
    )
    groq_model: str = Field(
        default="llama-3.3-70b-versatile",
        description="Groq-hosted model ID used by the orchestrator.",
    )

    # ---- App ----
    log_level: str = Field(default="INFO")
    host: str = Field(default="127.0.0.1")
    port: int = Field(default=8000)
    cors_allow_origins: str = Field(
        default="http://localhost:3000,http://localhost:5173",
        description="Comma-separated list of CORS origins.",
    )

    # ---- Agent behavior ----
    default_earliest: str = Field(
        default="-24h",
        description="Default earliest= for ad-hoc SPL when none provided.",
    )
    default_result_cap: int = Field(
        default=1000,
        description="Default `| head N` cap injected into non-aggregating SPL.",
    )
    max_agent_iterations: int = Field(
        default=8,
        description="Hard cap on the Reason/Investigate loop iterations.",
    )

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the singleton ``Settings`` instance."""
    return Settings()


def configure_logging(settings: Settings | None = None) -> None:
    """Apply the process-wide logging config based on ``LOG_LEVEL``."""
    settings = settings or get_settings()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
        datefmt="%H:%M:%S",
    )
