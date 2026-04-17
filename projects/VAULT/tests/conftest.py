"""Shared pytest fixtures for VAULT tests.

Every test gets an isolated SQLite DB in tmp_path. RPC and CLOB calls are mocked
unless a test explicitly asks for them (none currently do).
"""
import os
import sqlite3
from unittest.mock import patch

import pytest


@pytest.fixture
def db(tmp_path, monkeypatch):
    """Isolated SQLite DB per test. Returns an initialised sqlite3.Connection."""
    db_path = tmp_path / "vault.db"
    monkeypatch.setenv("VAULT_DB_FILE", str(db_path))
    # Bust the config cache so the new env var takes effect
    from vault import config_loader
    config_loader._config_cache = None

    from vault.db import init_db
    conn = init_db(db_path=db_path)
    yield conn
    conn.close()


@pytest.fixture
def seeded_db(db):
    """DB with the default $50 seed entry already applied."""
    from vault import ledger
    ledger.seed_balance(db, 50.0)
    return db


@pytest.fixture
def mock_rpc_ok():
    """Patch get_usdc_balance and get_ctf_balance to return configurable values.

    Yields a dict `{"usdc": float, "ctf": {token_id: shares}}` the test can mutate.
    """
    state = {"usdc": 50.0, "ctf": {}}

    def fake_usdc():
        return state["usdc"]

    def fake_ctf(token_id):
        return state["ctf"].get(str(token_id), 0.0)

    with patch("vault.clob_client.get_usdc_balance", side_effect=fake_usdc), \
         patch("vault.clob_client.get_ctf_balance", side_effect=fake_ctf):
        yield state


@pytest.fixture
def mock_rpc_down():
    """Patch RPC to always return None (simulating all-providers-dead)."""
    with patch("vault.clob_client.get_usdc_balance", return_value=None), \
         patch("vault.clob_client.get_ctf_balance", return_value=None):
        yield
