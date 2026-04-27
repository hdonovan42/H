"""Regression tests for the buy_shares stealth-fill detection.

Pinned to the 25 April 2026 Pereira failure: CLOB's post_order returned
success=True with trades=[] while 2.29 CTF shares were actually being
minted on-chain. The previous logic snapshotted USDC immediately and saw
no delta (settlement lagged the response), so it cancelled the prediction.
The drift safeguard then caught the mismatch and crash-looped the daemon.

These tests assert that buy_shares now polls CTF balance for several
seconds and treats any CTF increase as authoritative proof of fill.
"""
from unittest.mock import patch, MagicMock

import pytest

from vault.clob_client import buy_shares


def _mock_client_returning(resp):
    """Fake py_clob_client whose post_order returns the given resp."""
    client = MagicMock()
    client.create_market_order.return_value = "signed_order"
    client.post_order.return_value = resp
    return client


@pytest.fixture
def no_sleep():
    """Skip time.sleep so 10s polls run instantly."""
    with patch("time.sleep"):
        yield


def test_clob_lies_about_no_fills_but_ctf_shows_shares(no_sleep):
    """The Pereira regression: post_order returns success=True,trades=[] but
    CTF shows shares minted. buy_shares MUST return success and report the
    on-chain share count, not silently cancel."""
    fake_resp = {"success": True, "orderID": "ord_pereira", "trades": []}

    # USDC: settled by the time we re-check (1.48 spent).
    # CTF: 0 before the call, 2.29 after polling settles.
    usdc_before_raw = 100_000_000  # 100 USDC in 1e6 base units
    usdc_after_raw = 100_000_000 - 1_480_000  # spent 1.48

    with patch("vault.clob_client._get_client", return_value=_mock_client_returning(fake_resp)), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_before_raw, usdc_after_raw]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 2.28753]):
        result = buy_shares("token_pereira_yes", amount_usd=1.48, max_price=0.597)

    assert result.success is True, "MUST detect stealth fill, not cancel"
    assert result.shares == pytest.approx(2.28753), "shares must match on-chain"
    assert result.amount_usd == pytest.approx(1.48), "cost must match USDC delta"
    assert result.avg_price == pytest.approx(1.48 / 2.28753, rel=1e-3)


def test_clob_no_fills_ctf_unchanged_genuine_failure(no_sleep):
    """Truly empty fill: CTF unchanged, USDC unchanged → safe to declare no-fill."""
    fake_resp = {"success": True, "orderID": "ord_dry", "trades": []}
    usdc_raw = 100_000_000

    # CTF balance polled 5 times — all zero. side_effect must cover them all.
    with patch("vault.clob_client._get_client", return_value=_mock_client_returning(fake_resp)), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_raw, usdc_raw]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]):
        result = buy_shares("token_dry", amount_usd=1.48, max_price=0.6)

    assert result.success is False
    assert "no immediate liquidity" in (result.error or "")


def test_clob_no_fills_ctf_blind_returns_unverified(no_sleep):
    """RPC blind during CTF polling → must NOT cancel. Return UNVERIFIED so
    the bet actuator marks reconciling and the orphan sweep handles it."""
    fake_resp = {"success": True, "orderID": "ord_blind", "trades": []}
    usdc_raw = 100_000_000

    with patch("vault.clob_client._get_client", return_value=_mock_client_returning(fake_resp)), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_raw, usdc_raw]), \
         patch("vault.clob_client.get_ctf_balance", return_value=None):  # RPC dead
        result = buy_shares("token_blind", amount_usd=1.48, max_price=0.6)

    assert result.success is False
    assert (result.error or "").startswith("UNVERIFIED")


def test_clob_no_fills_usdc_moved_but_no_ctf_is_anomaly(no_sleep):
    """Money left the wallet but no shares minted → serious anomaly. MUST NOT
    silently cancel; surface as UNVERIFIED so an operator investigates."""
    fake_resp = {"success": True, "orderID": "ord_weird", "trades": []}
    usdc_before_raw = 100_000_000
    usdc_after_raw = 100_000_000 - 1_480_000  # USDC vanished

    with patch("vault.clob_client._get_client", return_value=_mock_client_returning(fake_resp)), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_before_raw, usdc_after_raw]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]):
        result = buy_shares("token_weird", amount_usd=1.48, max_price=0.6)

    assert result.success is False
    assert (result.error or "").startswith("UNVERIFIED")
