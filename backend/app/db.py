"""Connection pool with retry-and-backoff on startup.

The API process starts and answers /healthz immediately, even if Postgres is not up yet.
A background thread keeps trying to reach the database with exponential backoff and logs
every attempt; /readyz reports 503 until that succeeds. This is what lets the backend be
started before the database without crashing (and without Kubernetes restarting it).
"""

import logging
import random
import threading
from collections.abc import Iterator

import psycopg
from psycopg_pool import ConnectionPool, PoolTimeout

from .config import Settings

log = logging.getLogger("loantrack.db")


class DatabaseUnavailable(RuntimeError):
    """The database has not been reached yet, or a query could not get a connection."""


def backoff_delays(initial: float, maximum: float) -> Iterator[float]:
    """Yield 1x, 2x, 4x ... the initial delay, capped at `maximum` (no jitter)."""
    delay = initial
    while True:
        yield min(delay, maximum)
        delay = min(delay * 2, maximum)


class Database:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._pool = ConnectionPool(
            settings.conninfo,
            min_size=settings.pool_min_size,
            max_size=settings.pool_max_size,
            open=False,
            name="loantrack",
            # Drop connections that the server closed (e.g. Postgres pod restarted).
            check=ConnectionPool.check_connection,
        )
        self._connected = threading.Event()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def is_connected(self) -> bool:
        return self._connected.is_set()

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._connect_with_retry, name="db-connect", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._pool.close()

    def _connect_with_retry(self) -> None:
        s = self._settings
        delays = backoff_delays(s.retry_initial_delay, s.retry_max_delay)
        attempt = 0
        while not self._stopping.is_set():
            attempt += 1
            try:
                # A direct probe first: it fails fast with a readable error, unlike pool.wait().
                with psycopg.connect(s.conninfo, connect_timeout=3) as conn:
                    conn.execute("SELECT 1")
                if self._pool.closed:
                    self._pool.open(wait=False)
                self._pool.wait(timeout=10)
            except (psycopg.OperationalError, PoolTimeout) as exc:
                # +/-20% jitter so several replicas do not retry in lock-step.
                delay = next(delays) * random.uniform(0.8, 1.2)  # noqa: S311 - not crypto
                reason = (
                    str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
                )
                log.warning(
                    "database not reachable at %s:%s (attempt %d): %s - retrying in %.1fs",
                    s.db_host,
                    s.db_port,
                    attempt,
                    reason,
                    delay,
                )
                self._stopping.wait(delay)
                continue
            self._connected.set()
            log.info("database connection pool ready after %d attempt(s)", attempt)
            return

    def check(self) -> bool:
        """Readiness check: can we get a pooled connection and run a trivial query right now?"""
        if not self.is_connected:
            return False
        try:
            with self._pool.connection(timeout=2) as conn:
                conn.execute("SELECT 1")
        except (psycopg.Error, PoolTimeout) as exc:
            log.warning("readiness check failed: %s", exc)
            return False
        return True

    def connection(self):
        """Borrow a pooled connection. Raises DatabaseUnavailable instead of hanging."""
        if not self.is_connected:
            raise DatabaseUnavailable("database not connected yet")
        return self._pool.connection(timeout=5)
