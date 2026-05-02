"""Pinned tests for the v20.8 v2 migration audit findings.

Each test pins one v2 contract address or behaviour we depend on. If
Polymarket re-deploys, these go red and we fix once. The audit doc is
in tasks/v2-migration-audit.md.
"""
from unittest.mock import patch

import pytest

from vault.clob_client import (
    POLYGON_USDC_ADDRESS,
    POLYGON_PUSD_ADDRESS,
    CTF_CONTRACT,
    V2_EXCHANGE_ADDRESS,
    V2_NEG_RISK_EXCHANGE_ADDRESS,
    COLLATERAL_ONRAMP_ADDRESS,
)
from vault.wallet_sync import INTERNAL_ADDRESSES, _is_internal


def test_v2_addresses_pinned_to_clob_v2_repo():
    """All v2 contract addresses sourced from Polymarket/ctf-exchange-v2 README.
    If any of these change in a future Polymarket migration, tests go red and
    the affected code paths need updating."""
    # From clob-client-v2/src/config.ts MATIC_CONTRACTS
    assert V2_EXCHANGE_ADDRESS.lower() == "0xe111180000d2663c0091e4f400237545b87b996b"
    assert V2_NEG_RISK_EXCHANGE_ADDRESS.lower() == "0xe2222d279d744050d28e00520010520000310f59"
    # From ctf-exchange-v2/README.md "Polygon" deployments
    assert COLLATERAL_ONRAMP_ADDRESS.lower() == "0x93070a847efef7f70739046a929d47a521f5b8ee"
    # pUSD itself (the wrapped collateral)
    assert POLYGON_PUSD_ADDRESS.lower() == "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb"


def test_v1_addresses_unchanged():
    """v1 addresses must not drift — older positions still settle through them
    until they resolve, and our redeem path has both v1 and v2 adapters."""
    assert POLYGON_USDC_ADDRESS.lower() == "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
    assert CTF_CONTRACT.lower() == "0x4d97dcd97ec945f40cf65f87097ace5ea0476045"


def test_internal_addresses_includes_v2_ramps():
    """v2 wrap/unwrap inflows must not be classified as external deposits.
    Each v2 contract that touches our wallet during normal trading must be
    in INTERNAL_ADDRESSES."""
    assert _is_internal("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"), "pUSD"
    assert _is_internal("0x93070a847efEf7F70739046A929D47a521F5B8ee"), "CollateralOnramp"
    assert _is_internal("0x2957922Eb93258b93368531d39fAcCA3B4dC5854"), "CollateralOfframp"
    assert _is_internal("0xC417fD8E9661c0d2120B64a04Bb3278C17E99DB1"), "Collateral Vault"
    assert _is_internal("0xE111180000d2663C0091e4f400237545B87B996B"), "V2 Exchange"
    assert _is_internal("0xe2222d279d744050d28e00520010520000310F59"), "V2 NegRisk Exchange"
    assert _is_internal("0xADa100874d00e3331D00F2007a9c336a65009718"), "v2 CtfCollateralAdapter"
    assert _is_internal("0xAdA200001000ef00D07553cEE7006808F895c6F1"), "v2 NegRiskCtfCollateralAdapter"


def test_balance_includes_pusd():
    """Regression: until v20.8, _get_usdc_balance_raw read only USDC.e and
    drift detection fired the moment we wrapped USDC.e to pUSD for v2 trading.
    Now: balance is sum of USDC.e + pUSD, since they're 1:1 USD-pegged and
    interconvertible."""
    from vault.clob_client import _get_usdc_balance_raw
    with patch("vault.clob_client._call_with_rpc_fallback", side_effect=[2_000_000, 19_033_656]):
        with patch.dict("os.environ", {"POLYMARKET_PRIVATE_KEY": "0x" + "11" * 32}):
            total = _get_usdc_balance_raw()
    assert total == 21_033_656, f"expected USDC.e (2.0) + pUSD (19.033656) sum, got {total}"


def test_pusd_balance_helper_isolates_pusd():
    """get_pusd_balance_raw is for v2 trade-sizing where we need pUSD specifically
    (BUY orders settle from pUSD, not the combined balance). Used by the
    userUSDCBalance fee hint in v2 market orders."""
    from vault.clob_client import get_pusd_balance_raw
    with patch("vault.clob_client._call_with_rpc_fallback", return_value=19_033_656):
        with patch.dict("os.environ", {"POLYMARKET_PRIVATE_KEY": "0x" + "11" * 32}):
            pusd = get_pusd_balance_raw()
    assert pusd == 19_033_656


def test_setup_v2_allowances_actions_cover_required_grants():
    """Pin the exact set of allowances setup_v2_allowances grants. If a future
    Polymarket migration adds a new contract that needs approval, this test
    surfaces the gap during code review rather than at first failure."""
    import inspect
    from vault.clob_client import setup_v2_allowances
    src = inspect.getsource(setup_v2_allowances)
    # Check the five required grants are all spelled out
    required_pairs = [
        ("USDC.e -> CollateralOnramp", "lets us wrap USDC.e to pUSD"),
        ("pUSD -> V2_EXCHANGE", "pUSD when our BUY orders fill"),
        ("pUSD -> V2_NEG_RISK_EXCHANGE", "neg-risk markets"),
        ("CTF -> V2_EXCHANGE (setApprovalForAll)", "shares when SELL orders fill"),
        ("CTF -> V2_NEG_RISK_EXCHANGE (setApprovalForAll)", ""),
    ]
    for label, _ in required_pairs:
        assert label in src, f"setup_v2_allowances missing {label!r}"


def test_setup_v2_allowances_refuses_without_private_key(monkeypatch):
    monkeypatch.delenv("POLYMARKET_PRIVATE_KEY", raising=False)
    from vault.clob_client import setup_v2_allowances
    result = setup_v2_allowances()
    assert result["success"] is False
    assert "PRIVATE_KEY" in result["error"]
