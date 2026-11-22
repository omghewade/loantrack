"""Runtime configuration, read only from environment variables.

Nothing here has a default password: if DB_PASSWORD is missing the process refuses to start,
which is easier to diagnose than a confusing authentication error later.
"""

import os
import socket
from dataclasses import dataclass

from psycopg.conninfo import make_conninfo


class ConfigError(RuntimeError):
    """Raised when a required environment variable is missing or invalid."""


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"environment variable {name} is required")
    return value


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


@dataclass(frozen=True)
class Settings:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    pool_min_size: int
    pool_max_size: int
    retry_initial_delay: float
    retry_max_delay: float
    app_version: str
    instance_name: str
    log_level: str

    @property
    def conninfo(self) -> str:
        # make_conninfo quotes values safely, so a password containing spaces or quotes still works.
        return make_conninfo(
            host=self.db_host,
            port=self.db_port,
            dbname=self.db_name,
            user=self.db_user,
            password=self.db_password,
            application_name=f"loantrack-backend@{self.instance_name}",
        )

    @classmethod
    def from_env(cls) -> "Settings":
        settings = cls(
            db_host=_required("DB_HOST"),
            db_port=_int("DB_PORT", 5432),
            db_name=_required("DB_NAME"),
            db_user=_required("DB_USER"),
            db_password=_required("DB_PASSWORD"),
            pool_min_size=_int("DB_POOL_MIN_SIZE", 1),
            pool_max_size=_int("DB_POOL_MAX_SIZE", 5),
            retry_initial_delay=_float("DB_RETRY_INITIAL_DELAY", 1.0),
            retry_max_delay=_float("DB_RETRY_MAX_DELAY", 30.0),
            app_version=os.environ.get("APP_VERSION", "dev"),
            # In Kubernetes this is the pod name (downward API); in Compose, the container id.
            instance_name=os.environ.get("INSTANCE_NAME") or socket.gethostname(),
            log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        )
        if not 1 <= settings.pool_min_size <= settings.pool_max_size:
            raise ConfigError("need 1 <= DB_POOL_MIN_SIZE <= DB_POOL_MAX_SIZE")
        return settings
