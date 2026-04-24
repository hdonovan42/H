"""Tests for the native USDC → USDC.e auto-swap logic.

We mock the on-chain swap function — the actual swap is an integration test
better run against a Polygon fork or manual test, not in CI.
"""
from unittest.mock import patch

import pytest

from vault import ledger
from vault.daemon import _auto_swap_native_usdc


@pytest.fixture
def real_mode_cfg():
    return {
        "trading": {
            "simulated": False,
            "clob": {
                "auto_swap_native_usdc": True,
                "min_native_swap_usd": 1.00,
                "native_swap_slippage_bps": 50,
            },
        },
    }


def _event_count(db, event):
    return db.execute("SELECT COUNT(*) FROM events WHERE event = ?", (event,)).fetchone()[0]


def test_no_swap_when_native_balance_below_threshold(seeded_db, real_mode_cfg):
    """Dust amounts of native USDC shouldn't trigger a swap (would burn gas on <$0.50 of swap)."""
    ledger.go_live_reset(seeded_db, 12.67)
    with patch("vault.clob_client.get_native_usdc_balance", return_value=0.25):
        swapped = _auto_swap_native_usdc(seeded_db, real_mode_cfg)
    assert swapped is False
    assert _event_count(seeded_db, "auto_swap") == 0


def test_no_swap_when_rpc_unavailable(seeded_db, real_mode_cfg):
    """If RPC can't even tell us the native balance, don't attempt a swap."""
    ledger.go_live_reset(seeded_db, 12.67)
    with patch("vault.clob_client.get_native_usdc_balance", return_value=None):
        swapped = _auto_swap_native_usdc(seeded_db, real_mode_cfg)
    assert swapped is False


def test_swap_fires_and_logs_event_when_over_threshold(seeded_db, real_mode_cfg):
    """Native USDC ≥ threshold → swap fn called → success logged to events."""
    ledger.go_live_reset(seeded_db, 12.67)
    fake_result = {
        "success": True,
        "amount_in": 10.0,
        "amount_out": 9.99,
        "tx_hash": "0xabc123def456789",
        "gas_cost_matic": 0.019,
    }
    with patch("vault.clob_client.get_native_usdc_balance", return_value=10.0), \
         patch("vault.clob_client.swap_native_to_bridged_usdc", return_value=fake_result) as mock_swap:
        swapped = _auto_swap_native_usdc(seeded_db, real_mode_cfg)

    assert swapped is True
    mock_swap.assert_called_once_with(10.0, slippage_bps=50)
    assert _event_count(seeded_db, "auto_swap") == 1

    detail = seeded_db.execute("SELECT detail FROM events WHERE event = 'auto_swap'").fetchone()[0]
    assert "$10.0000" in detail
    assert "$9.9900" in detail
    assert "0xabc123de" in detail  # truncated tx hash


def test_swap_failure_records_failed_event(seeded_db, real_mode_cfg):
    """If the swap fn reports failure, we log auto_swap_failed but DON'T crash the daemon."""
    ledger.go_live_reset(seeded_db, 12.67)
    fake_result = {"success": False, "error": "insufficient MATIC for gas"}
    with patch("vault.clob_client.get_native_usdc_balance", return_value=5.0), \
         patch("vault.clob_client.swap_native_to_bridged_usdc", return_value=fake_result):
        swapped = _auto_swap_native_usdc(seeded_db, real_mode_cfg)

    assert swapped is False
    assert _event_count(seeded_db, "auto_swap") == 0
    assert _event_count(seeded_db, "auto_swap_failed") == 1


def test_feature_flag_off_skips_swap(seeded_db):
    """Setting `auto_swap_native_usdc: false` disables the feature entirely."""
    ledger.go_live_reset(seeded_db, 12.67)
    cfg = {"trading": {"clob": {"auto_swap_native_usdc": False, "min_native_swap_usd": 1.00}}}

    with patch("vault.clob_client.get_native_usdc_balance") as mock_bal:
        swapped = _auto_swap_native_usdc(seeded_db, cfg)

    assert swapped is False
    mock_bal.assert_not_called()  # short-circuit; never even asks for balance


def test_custom_slippage_bps_passed_through(seeded_db):
    """The config-level slippage_bps is forwarded to the swap function."""
    ledger.go_live_reset(seeded_db, 12.67)
    cfg = {
        "trading": {
            "clob": {
                "auto_swap_native_usdc": True,
                "min_native_swap_usd": 1.00,
                "native_swap_slippage_bps": 25,  # custom value
            },
        },
    }
    fake_result = {"success": True, "amount_in": 5.0, "amount_out": 4.99, "tx_hash": "0x123", "gas_cost_matic": 0.01}
    with patch("vault.clob_client.get_native_usdc_balance", return_value=5.0), \
         patch("vault.clob_client.swap_native_to_bridged_usdc", return_value=fake_result) as mock_swap:
        _auto_swap_native_usdc(seeded_db, cfg)
    mock_swap.assert_called_once_with(5.0, slippage_bps=25)
