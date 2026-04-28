"""Tests for wallet_sync: reset_and_seed + deposit/withdrawal detection logic.

The on-chain log-fetch itself is hard to unit-test without a forked Polygon node,
so these tests focus on:
  - reset_and_seed: wipes correctly, preserves meta, inserts seed entries
  - compute_expected_onchain correctly subtracts withdrawals
  - INTERNAL_ADDRESSES classification
"""
import os
from unittest.mock import patch

import pytest

from vault import ledger
from vault.wallet_sync import INTERNAL_ADDRESSES, _is_internal, _label_counterparty, reset_and_seed


def test_internal_addresses_lowercase():
    """All entries in the known-internal set must be lowercase (we compare lowercased)."""
    for addr in INTERNAL_ADDRESSES:
        assert addr == addr.lower(), f"{addr} should be lowercase"


def test_is_internal_detects_polymarket_exchanges():
    """Polymarket CTF + Neg-Risk exchanges are always internal."""
    assert _is_internal("0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E") is True
    assert _is_internal("0xC5d563A36AE78145C45a50134d48A1215220f80a") is True


def test_is_internal_detects_neg_risk_redemption_sources():
    """Regression: USDC.e arriving from a neg-risk redemption is NOT a deposit.
    Pereira redemption (Apr 27 2026) sent USDC.e from the neg-risk vault to
    our wallet — wallet_sync logged it as a +$2.29 deposit, double-counting
    the prediction_resolve credit and creating a $-2.29 reconciliation drift.
    Both the NegRiskAdapter and the underlying vault must be classified as
    internal so future redemptions don't re-trigger the same bug."""
    assert _is_internal("0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296") is True  # NegRiskAdapter
    assert _is_internal("0x3a3bd7bb9528e159577f7c2e685cc81a765002e2") is True  # Neg-Risk Vault


def test_is_internal_ignores_external_wallet():
    """Random addresses are external (cashflow)."""
    assert _is_internal("0x1234567890123456789012345678901234567890") is False


def test_label_counterparty_returns_label_for_known():
    """Known internal addresses get a friendly label."""
    assert "Polymarket" in _label_counterparty("0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E")


def test_label_counterparty_returns_raw_for_unknown():
    """Unknown addresses come back as their lowercase hex."""
    addr = "0x1234567890123456789012345678901234567890"
    assert _label_counterparty(addr) == addr.lower()


@pytest.fixture
def mock_onchain(monkeypatch):
    """Mock on-chain reads during reset tests so we don't hit a real RPC."""
    def fake_get_usdc_balance():
        return 12.67

    def fake_call_with_fallback(fn, *, label):
        # Simulate a successful RPC for block-number queries
        if "block" in label:
            return 85_000_000
        return fn(None)

    monkeypatch.setattr("vault.clob_client.get_usdc_balance", fake_get_usdc_balance)
    monkeypatch.setattr("vault.clob_client._call_with_rpc_fallback", fake_call_with_fallback)
    return {"usdc": 12.67}


def test_reset_wipes_cycles_and_predictions(seeded_db, mock_onchain):
    """After reset, transactional tables must be empty."""
    # Pollute the DB first
    seeded_db.execute("INSERT INTO cycles (ts_start) VALUES ('2026-01-01T00:00:00Z')")
    seeded_db.execute(
        "INSERT INTO predictions (market_id, question, side, shares, entry_odds, cost_basis, status) "
        "VALUES ('m', 'q', 'YES', 1.0, 0.5, 1.0, 'closed')"
    )
    seeded_db.execute("INSERT INTO events (event, detail) VALUES ('test', 'before reset')")
    seeded_db.commit()

    reset_and_seed(seeded_db, seed_amount=12.67)

    assert seeded_db.execute("SELECT COUNT(*) FROM cycles").fetchone()[0] == 0
    assert seeded_db.execute("SELECT COUNT(*) FROM predictions").fetchone()[0] == 0
    # Events gets re-populated with accounting_reset + go_live on the fresh start
    events = [r[0] for r in seeded_db.execute("SELECT event FROM events").fetchall()]
    assert "accounting_reset" in events
    assert "go_live" in events
    assert "test" not in events


def test_reset_wipes_cycles_despite_foreign_key_references(seeded_db, mock_onchain):
    """Regression: pipeline_runs.cycle_id FK into cycles.id made DELETE FROM cycles fail
    silently under PRAGMA foreign_keys=ON. The fix disables FKs during wipe; this test
    guards against the silent-failure pattern returning.
    """
    # Insert a parent cycle plus a child that references it
    cur = seeded_db.execute("INSERT INTO cycles (ts_start) VALUES ('2026-01-01T00:00:00Z')")
    cycle_id = cur.lastrowid
    seeded_db.execute(
        "INSERT INTO pipeline_runs (cycle_id, ts) VALUES (?, '2026-01-01T00:00:00Z')",
        (cycle_id,),
    )
    seeded_db.commit()
    assert seeded_db.execute("SELECT COUNT(*) FROM cycles").fetchone()[0] == 1
    assert seeded_db.execute("SELECT COUNT(*) FROM pipeline_runs").fetchone()[0] == 1

    reset_and_seed(seeded_db, seed_amount=12.67)

    assert seeded_db.execute("SELECT COUNT(*) FROM cycles").fetchone()[0] == 0, \
        "cycles survived the reset — FK constraint blocked the DELETE silently"
    assert seeded_db.execute("SELECT COUNT(*) FROM pipeline_runs").fetchone()[0] == 0

    # And foreign keys should be re-enabled post-reset
    fk_enabled = seeded_db.execute("PRAGMA foreign_keys").fetchone()[0]
    assert fk_enabled == 1, "Reset must leave foreign_keys enabled"


def test_reset_preserves_schema_version(seeded_db, mock_onchain):
    """Reset must NOT wipe the schema_version or alive meta keys."""
    from vault.db import SCHEMA_VERSION
    reset_and_seed(seeded_db, seed_amount=12.67)
    schema_v = seeded_db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
    alive = seeded_db.execute("SELECT value FROM meta WHERE key='alive'").fetchone()[0]
    assert int(schema_v) == SCHEMA_VERSION
    assert alive == "true"


def test_reset_clears_paused_flag(seeded_db, mock_onchain):
    """If the pre-reset daemon was paused, post-reset should clear it."""
    from vault.db import set_meta
    set_meta(seeded_db, "paused", "true")
    seeded_db.commit()
    reset_and_seed(seeded_db, seed_amount=12.67)
    paused = seeded_db.execute("SELECT value FROM meta WHERE key='paused'").fetchone()
    assert paused is None or paused[0] != "true"


def test_reset_seeds_as_deposit_not_seed_type(seeded_db, mock_onchain):
    """User asked: the initial balance should be recorded as a DEPOSIT entry, not a 'seed' type."""
    reset_and_seed(seeded_db, seed_amount=12.67)
    entries = seeded_db.execute(
        "SELECT entry_type, amount, description FROM ledger ORDER BY id ASC"
    ).fetchall()
    assert len(entries) == 2, f"Expected 2 ledger entries (deposit + go_live_reset), got {len(entries)}"
    assert entries[0][0] == "deposit"
    assert entries[0][1] == pytest.approx(12.67)
    assert "Initial deposit" in entries[0][2]
    assert entries[1][0] == "go_live_reset"


def test_reset_creates_wallet_transactions_seed_row(seeded_db, mock_onchain):
    """The initial deposit must appear in wallet_transactions so the Cashflow UI shows it."""
    reset_and_seed(seeded_db, seed_amount=12.67)
    rows = seeded_db.execute(
        "SELECT direction, amount_usd, counterparty, tx_hash FROM wallet_transactions"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "deposit"
    assert rows[0][1] == pytest.approx(12.67)
    assert rows[0][2] == "Initial seed"
    assert rows[0][3].startswith("reset-seed-")


def test_reset_post_state_is_live_with_correct_balance(seeded_db, mock_onchain):
    """Post-reset, is_live() must return True and balance must equal the seed."""
    reset_and_seed(seeded_db, seed_amount=12.67)
    assert ledger.is_live(seeded_db) is True
    assert ledger.get_balance(seeded_db) == pytest.approx(12.67)


def test_compute_expected_onchain_handles_withdrawals(seeded_db, mock_onchain):
    """A recorded withdrawal (negative ledger amount) must reduce expected_onchain."""
    reset_and_seed(seeded_db, seed_amount=12.67)
    assert ledger.compute_expected_onchain(seeded_db) == pytest.approx(12.67)

    # Simulate a $5 withdrawal (amount is stored negative)
    seeded_db.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES ('withdrawal', -5.0, 'test withdrawal', 7.67)"
    )
    seeded_db.commit()

    # expected = anchor (12.67) + deposits_after_anchor (0) + withdrawals_after_anchor (-5) = 7.67
    assert ledger.compute_expected_onchain(seeded_db) == pytest.approx(7.67)


def test_deposits_and_withdrawals_both_counted_after_anchor(seeded_db, mock_onchain):
    """A mix of deposits and withdrawals since go-live should net correctly."""
    reset_and_seed(seeded_db, seed_amount=10.00)
    seeded_db.execute("INSERT INTO ledger (entry_type, amount, description, balance_after) VALUES ('deposit', 5.0, 'd1', 15.0)")
    seeded_db.execute("INSERT INTO ledger (entry_type, amount, description, balance_after) VALUES ('withdrawal', -3.0, 'w1', 12.0)")
    seeded_db.execute("INSERT INTO ledger (entry_type, amount, description, balance_after) VALUES ('deposit', 2.0, 'd2', 14.0)")
    seeded_db.commit()
    # anchor 10 + deposits_net (5 - 3 + 2 = 4) = 14
    assert ledger.compute_expected_onchain(seeded_db) == pytest.approx(14.0)
