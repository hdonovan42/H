"""Tests for RPC-failure handling in balance divergence checks.

Regression target: 15 March 2026 incident. When the Polygon RPC returned 401s for hours,
`check_balance_divergence` silently short-circuited on `onchain is None` and the daemon
kept trading blind. Fix: repeated `None` returns now auto-pause the daemon.
"""
from unittest.mock import patch

import pytest

from vault.guardrails import check_balance_divergence
from vault.ledger import go_live_reset
from vault.db import get_meta


def test_rpc_none_increments_failure_counter(seeded_db):
    """When RPC returns None, the counter increments but no pause yet."""
    go_live_reset(seeded_db, 50.0)

    with patch("vault.clob_client.get_usdc_balance", return_value=None):
        diverged, detail = check_balance_divergence(seeded_db, tolerance=0.50, rpc_failure_threshold=3)
    assert diverged is False
    assert "1/3" in detail
    assert get_meta(seeded_db, "rpc_failures_consecutive") == "1"
    assert get_meta(seeded_db, "paused") != "true"


def test_rpc_none_pauses_after_threshold(seeded_db):
    """Three consecutive None returns must auto-pause the daemon."""
    go_live_reset(seeded_db, 50.0)

    with patch("vault.clob_client.get_usdc_balance", return_value=None):
        check_balance_divergence(seeded_db, rpc_failure_threshold=3)
        check_balance_divergence(seeded_db, rpc_failure_threshold=3)
        diverged, detail = check_balance_divergence(seeded_db, rpc_failure_threshold=3)

    assert diverged is True
    assert "RPC unavailable" in detail
    assert get_meta(seeded_db, "paused") == "true"


def test_rpc_success_resets_failure_counter(seeded_db):
    """A successful RPC read must zero the counter so transient failures don't accumulate forever."""
    go_live_reset(seeded_db, 50.0)

    with patch("vault.clob_client.get_usdc_balance", return_value=None):
        check_balance_divergence(seeded_db, rpc_failure_threshold=3)
        check_balance_divergence(seeded_db, rpc_failure_threshold=3)
    assert get_meta(seeded_db, "rpc_failures_consecutive") == "2"

    with patch("vault.clob_client.get_usdc_balance", return_value=50.0):
        diverged, _ = check_balance_divergence(seeded_db, rpc_failure_threshold=3)
    assert diverged is False
    assert get_meta(seeded_db, "rpc_failures_consecutive") == "0"


def test_negative_drift_pauses_regardless_of_rpc(seeded_db):
    """With a working RPC, negative drift beyond tolerance must still pause immediately."""
    go_live_reset(seeded_db, 50.0)

    # On-chain is $40, expected is $50 → drift -$10, well beyond $0.50 tolerance
    with patch("vault.clob_client.get_usdc_balance", return_value=40.0):
        diverged, detail = check_balance_divergence(seeded_db, tolerance=0.50)

    assert diverged is True
    assert "divergence" in detail.lower()
    assert get_meta(seeded_db, "paused") == "true"


def test_positive_drift_does_not_pause(seeded_db):
    """Positive drift (deposit detected) is logged but does not pause."""
    go_live_reset(seeded_db, 50.0)

    with patch("vault.clob_client.get_usdc_balance", return_value=60.0):
        diverged, _ = check_balance_divergence(seeded_db, tolerance=0.50)

    assert diverged is False
    assert get_meta(seeded_db, "paused") != "true"


def test_regression_15_march_scenario(seeded_db):
    """End-to-end regression: simulate the exact 15 March conditions.

    - Ledger has paper $51.29
    - go_live_reset snapped balance to $0 (on-chain was empty)
    - RPC now returns None three times in a row (old polygon-rpc.com 401s)

    Expected behaviour: daemon pauses after 3rd failure. The PRE-FIX behaviour was
    to return (False, "RPC unavailable") and keep trading — which is how the $50
    was lost once orders started succeeding.
    """
    # Simulate paper history
    from vault import ledger
    ledger.deduct_api_cost(seeded_db, 1.0, "paper cost")
    # Fake paper profit bringing balance up to ~$51.29
    seeded_db.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES ('prediction_resolve', 2.29, 'paper win', 51.29)"
    )
    seeded_db.commit()

    # Go live with an empty wallet (user hasn't deposited yet)
    go_live_reset(seeded_db, 0.0)

    # Now RPC dies. Three consecutive cycles.
    with patch("vault.clob_client.get_usdc_balance", return_value=None):
        diverged_1, _ = check_balance_divergence(seeded_db, tolerance=0.50, rpc_failure_threshold=3)
        diverged_2, _ = check_balance_divergence(seeded_db, tolerance=0.50, rpc_failure_threshold=3)
        diverged_3, _ = check_balance_divergence(seeded_db, tolerance=0.50, rpc_failure_threshold=3)

    assert diverged_1 is False
    assert diverged_2 is False
    assert diverged_3 is True, "Daemon should have paused on the third consecutive RPC None — this is the 15 March fix"
    assert get_meta(seeded_db, "paused") == "true"
