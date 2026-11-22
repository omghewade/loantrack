from itertools import islice

import pytest

from app.config import ConfigError, Settings
from app.db import backoff_delays
from app.repository import _like_pattern

DB_ENV = {"DB_HOST": "db", "DB_NAME": "loantrack", "DB_USER": "app", "DB_PASSWORD": "p@ss w'rd"}


def test_backoff_doubles_then_caps():
    assert list(islice(backoff_delays(1, 8), 6)) == [1, 2, 4, 8, 8, 8]


def test_settings_from_env(monkeypatch):
    for key, value in DB_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("INSTANCE_NAME", "backend-abc")
    settings = Settings.from_env()
    assert settings.db_port == 5432
    assert settings.instance_name == "backend-abc"
    # password with a space and a quote must survive into the connection string intact
    assert "password='p@ss w\\'rd'" in settings.conninfo


def test_missing_password_fails_fast(monkeypatch):
    for key, value in DB_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("DB_PASSWORD")
    with pytest.raises(ConfigError, match="DB_PASSWORD"):
        Settings.from_env()


def test_bad_pool_sizes_rejected(monkeypatch):
    for key, value in DB_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("DB_POOL_MIN_SIZE", "10")
    monkeypatch.setenv("DB_POOL_MAX_SIZE", "2")
    with pytest.raises(ConfigError):
        Settings.from_env()


def test_like_pattern_escapes_wildcards():
    assert _like_pattern("50%_off") == "%50\\%\\_off%"
