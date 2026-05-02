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

from vault.clob_client import buy_shares, sell_shares


def _mock_sell_client():
    """SELL variant of _mock_client — same idea but the v1 dict has SELL side
    and amounts framed as shares-out / USDC-in."""
    v1_signed = MagicMock()
    v1_signed.dict.return_value = {
        "maker": "0x" + "00" * 20,
        "tokenId": "1",
        "makerAmount": "2120000",  # selling 2.12 CTF shares
        "takerAmount": "763200",   # for at least $0.7632 USDC
        "side": "SELL",
        "signatureType": 0,
    }
    client = MagicMock()
    client.create_market_order.return_value = v1_signed
    client.get_neg_risk.return_value = False
    return client


def _mock_client():
    """Fake py_clob_client. Since the v2 migration we use the SDK only for
    maker/taker amount calculation + neg_risk lookup; the actual order is
    signed and POSTed by vault.clob_v2. The v1 SignedOrder needs a .dict()
    method that returns the fields our v2 builder reads."""
    v1_signed = MagicMock()
    v1_signed.dict.return_value = {
        "maker": "0x" + "00" * 20,
        "tokenId": "1",
        "makerAmount": "1480000",
        "takerAmount": "2480000",
        "side": "BUY",
        "signatureType": 0,
    }
    client = MagicMock()
    client.create_market_order.return_value = v1_signed
    client.get_neg_risk.return_value = False
    return client


@pytest.fixture(autouse=True)
def _no_real_signing(monkeypatch):
    """Stub the v2 sign+POST so we don't need a private key in unit tests.
    Each test patches `vault.clob_client.post_order_v2` to return its specific
    response payload. The stub here is a safety net so a missed mock doesn't
    accidentally hit the live API."""
    def _refuse(*args, **kwargs):
        raise RuntimeError("post_order_v2 called without a per-test mock — fix the test")
    monkeypatch.setenv("POLYMARKET_PRIVATE_KEY", "0x" + "11" * 32)
    monkeypatch.setattr("vault.clob_v2.post_order_v2", _refuse)
    monkeypatch.setattr(
        "vault.clob_v2.build_signed_order_v2",
        lambda **kwargs: {"signature": "0xstub"},
    )


@pytest.fixture
def no_sleep():
    """Skip time.sleep so 10s polls run instantly."""
    with patch("time.sleep"):
        yield


def test_clob_lies_about_no_fills_but_ctf_shows_shares(no_sleep, monkeypatch):
    """The Pereira regression: response says success=True,trades=[] but
    CTF shows shares minted. buy_shares MUST return success and report the
    on-chain share count, not silently cancel."""
    fake_resp = {"success": True, "orderID": "ord_pereira", "trades": []}

    # USDC: settled by the time we re-check (1.48 spent).
    # CTF: 0 before the call, 2.29 after polling settles.
    usdc_before_raw = 100_000_000
    usdc_after_raw = 100_000_000 - 1_480_000

    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_before_raw, usdc_after_raw]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 2.28753]):
        result = buy_shares("token_pereira_yes", amount_usd=1.48, max_price=0.597)

    assert result.success is True, "MUST detect stealth fill, not cancel"
    assert result.shares == pytest.approx(2.28753)
    assert result.amount_usd == pytest.approx(1.48)
    assert result.avg_price == pytest.approx(1.48 / 2.28753, rel=1e-3)


def test_clob_no_fills_ctf_unchanged_genuine_failure(no_sleep, monkeypatch):
    """Truly empty fill: CTF unchanged, USDC unchanged → safe to declare no-fill."""
    fake_resp = {"success": True, "orderID": "ord_dry", "trades": []}
    usdc_raw = 100_000_000

    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_raw, usdc_raw]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]):
        result = buy_shares("token_dry", amount_usd=1.48, max_price=0.6)

    assert result.success is False
    assert "no immediate liquidity" in (result.error or "")


def test_clob_no_fills_ctf_blind_returns_unverified(no_sleep, monkeypatch):
    """RPC blind during CTF polling → must NOT cancel. Return UNVERIFIED so
    the bet actuator marks reconciling and the orphan sweep handles it."""
    fake_resp = {"success": True, "orderID": "ord_blind", "trades": []}
    usdc_raw = 100_000_000

    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_raw, usdc_raw]), \
         patch("vault.clob_client.get_ctf_balance", return_value=None):
        result = buy_shares("token_blind", amount_usd=1.48, max_price=0.6)

    assert result.success is False
    assert (result.error or "").startswith("UNVERIFIED")


def test_clob_no_fills_usdc_moved_but_no_ctf_is_anomaly(no_sleep, monkeypatch):
    """Money left the wallet but no shares minted → serious anomaly. MUST NOT
    silently cancel; surface as UNVERIFIED so an operator investigates."""
    fake_resp = {"success": True, "orderID": "ord_weird", "trades": []}
    usdc_before_raw = 100_000_000
    usdc_after_raw = 100_000_000 - 1_480_000  # USDC vanished

    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_before_raw, usdc_after_raw]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]):
        result = buy_shares("token_weird", amount_usd=1.48, max_price=0.6)

    assert result.success is False
    assert (result.error or "").startswith("UNVERIFIED")


# ── SELL stealth-fill tests (v20.8.2 regression: pred #98) ─────────────────

def test_sell_clob_lies_about_no_fills_but_ctf_decreased(no_sleep, monkeypatch):
    """The 2 May 2026 pred #98 regression: v2's /order returned `success`
    without a `trades` key for a SELL FAK fill. Daemon thought 'no liquidity'
    and left predictions.shares=2.125 in the DB. On-chain, 2.120 shares had
    actually moved out and $0.84 USDC arrived. sell_shares MUST detect this
    via CTF poll (mirror of the v20.1 buy_shares logic) and report success."""
    fake_resp = {"success": True, "orderID": "ord_pred98", "trades": []}

    # USDC: $0.84 arrived (before=$2, after=$2.84 in raw 1e6 units)
    usdc_before = 2_000_000
    usdc_after = 2_000_000 + 842_855

    # CTF: held 2.125 before, 0.005 after (2.120 sold)
    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_sell_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_before, usdc_after]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[2.125, 0.005]):
        result = sell_shares("token_pred98", shares=2.120, min_price=0.36)

    assert result.success is True, "MUST detect SELL stealth fill, not silently fail"
    assert result.shares == pytest.approx(2.120)
    assert result.amount_usd == pytest.approx(0.842855)
    assert result.avg_price == pytest.approx(0.842855 / 2.120, rel=1e-3)


def test_sell_no_fills_ctf_unchanged_genuine_failure(no_sleep, monkeypatch):
    """Truly empty SELL: CTF unchanged, USDC unchanged → safe to declare no-fill."""
    fake_resp = {"success": True, "orderID": "ord_dry_sell", "trades": []}
    usdc_raw = 2_000_000

    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_sell_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_raw, usdc_raw]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[2.0, 2.0, 2.0, 2.0, 2.0, 2.0]):
        result = sell_shares("token_dry", shares=1.0, min_price=0.5)

    assert result.success is False
    assert "no immediate liquidity" in (result.error or "")


def test_sell_no_fills_ctf_blind_returns_unverified(no_sleep, monkeypatch):
    """RPC blind during CTF polling → must NOT silently cancel a SELL.
    Return UNVERIFIED so caller marks reconciling, orphan sweep handles."""
    fake_resp = {"success": True, "orderID": "ord_blind_sell", "trades": []}
    usdc_raw = 2_000_000

    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_sell_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_raw, usdc_raw]), \
         patch("vault.clob_client.get_ctf_balance", return_value=None):
        result = sell_shares("token_blind", shares=1.0, min_price=0.5)

    assert result.success is False
    assert (result.error or "").startswith("UNVERIFIED")


def test_sell_no_fills_usdc_arrived_without_ctf_burn_is_anomaly(no_sleep, monkeypatch):
    """USDC arrived but CTF didn't move — money for shares we still hold.
    Refuse to silently cancel; surface as UNVERIFIED."""
    fake_resp = {"success": True, "orderID": "ord_weird_sell", "trades": []}
    usdc_before = 2_000_000
    usdc_after = 2_000_000 + 842_855

    monkeypatch.setattr("vault.clob_v2.post_order_v2", lambda **kw: fake_resp)
    with patch("vault.clob_client._get_client", return_value=_mock_sell_client()), \
         patch("vault.clob_client._get_usdc_balance_raw", side_effect=[usdc_before, usdc_after]), \
         patch("vault.clob_client.get_ctf_balance", side_effect=[2.0, 2.0, 2.0, 2.0, 2.0, 2.0]):
        result = sell_shares("token_weird_sell", shares=1.0, min_price=0.5)

    assert result.success is False
    assert (result.error or "").startswith("UNVERIFIED")
