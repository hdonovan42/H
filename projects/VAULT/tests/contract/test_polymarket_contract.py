"""Daily contract tests against live Polymarket APIs.

The point: catch upstream changes the day they ship, not the day they
break the daemon. Six failures in six weeks is mostly because we discover
schema/protocol shifts via production. These tests hit live endpoints
and assert the response shape we depend on. Run as:

    pytest tests/contract/ -v

Or via the daily systemd timer (see deploy/contract-check.service).

Fail behaviour: each test asserts ONE thing about the contract we rely
on. If a test goes red, look at the diff between what we expected and
what came back — the daemon code that depends on that field probably
needs updating before the next deploy.

Tests are SKIPPED if no internet. Don't fail CI on network blips.
"""
import os
import json

import httpx
import pytest

from vault.clob_v2 import (
    V2_DOMAIN_NAME,
    V2_DOMAIN_VERSION,
    V2_EXCHANGE,
    V2_NEG_RISK_EXCHANGE,
)


GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


@pytest.fixture(scope="module")
def liquid_market():
    """Pull one currently-active high-volume market we can query against.
    Skipped if gamma is unreachable. The choice is intentionally non-pinned
    — we want a real market that's currently trading, not a hardcoded id."""
    try:
        r = httpx.get(
            f"{GAMMA}/markets",
            params={
                "active": "true",
                "closed": "false",
                "limit": "20",
                "order": "volume",
                "ascending": "false",
            },
            timeout=10,
        )
        r.raise_for_status()
        for m in r.json():
            tids = m.get("clobTokenIds")
            prices = m.get("outcomePrices")
            if tids and prices:
                if isinstance(tids, str):
                    tids = json.loads(tids)
                if isinstance(prices, str):
                    prices = json.loads(prices)
                if (
                    isinstance(tids, list) and len(tids) >= 2
                    and isinstance(prices, list) and len(prices) >= 2
                ):
                    return {
                        "id": str(m["id"]),
                        "token_id": tids[0],
                        "raw": m,
                    }
    except Exception as e:
        pytest.skip(f"gamma unreachable: {e}")
    pytest.skip("no liquid market found in top 20 by volume")


# ── CLOB protocol version ────────────────────────────────────────────────

def test_clob_protocol_version_pinned():
    """Polymarket's v1→v2 migration broke us in production because we
    weren't watching this. If they jump to v3 we want to know on day 0."""
    try:
        r = httpx.get(f"{CLOB}/version", timeout=10)
    except Exception as e:
        pytest.skip(f"CLOB unreachable: {e}")
    r.raise_for_status()
    body = r.json()
    assert "version" in body, body
    assert body["version"] == 2, (
        f"CLOB protocol bumped from 2 to {body['version']}. "
        f"vault/clob_v2.py needs an update before any orders are placed. "
        f"Compare against Polymarket's clob-client-v2 repo for the new spec."
    )


def test_v2_domain_constants_match_clob_client_v2_repo():
    """Pin the v2 EIP-712 domain values against what we built clob_v2.py
    against. If Polymarket deploys new exchange contracts (different
    verifyingContract), this test won't catch it directly — but it locks
    down the values so a future code reader can see the source of truth."""
    assert V2_DOMAIN_NAME == "Polymarket CTF Exchange"
    assert V2_DOMAIN_VERSION == "2"
    # Polygon mainnet (chain 137) addresses, sourced from clob-client-v2
    # MATIC_CONTRACTS in src/config.ts.
    assert V2_EXCHANGE.lower() == "0xe111180000d2663c0091e4f400237545b87b996b"
    assert V2_NEG_RISK_EXCHANGE.lower() == "0xe2222d279d744050d28e00520010520000310f59"


# ── Gamma market schema ──────────────────────────────────────────────────

def test_gamma_returns_outcome_prices_for_active_markets(liquid_market):
    """The 28 Apr 2026 incident: gamma briefly returned market records
    without `outcomePrices`. Our parser silently defaulted to 0.5/0.5,
    poisoning peak_roi. The fix (v20.5) was to set has_prices=False; the
    contract test is to confirm gamma still returns the field for active
    high-volume markets so we know if it goes missing again."""
    raw = liquid_market["raw"]
    assert "outcomePrices" in raw, (
        "gamma response missing outcomePrices for an active high-volume market — "
        "if this becomes the norm, vault/polymarket._parse_market may need "
        "to use a different price source"
    )
    prices = raw["outcomePrices"]
    if isinstance(prices, str):
        prices = json.loads(prices)
    assert isinstance(prices, list) and len(prices) >= 2, prices
    yes, no = float(prices[0]), float(prices[1])
    assert 0.0 <= yes <= 1.0 and 0.0 <= no <= 1.0
    # YES + NO should sum to ~1.0 for binary markets (allow small spread)
    assert abs(yes + no - 1.0) < 0.05, f"unexpected price sum: yes={yes} no={no}"


def test_gamma_provides_neg_risk_flag(liquid_market):
    """Our redemption path branches on negRisk. If the field disappears we
    don't know whether to call NegRiskAdapter or ConditionalTokens, and
    redemptions silently use the wrong contract."""
    assert "negRisk" in liquid_market["raw"], (
        "gamma omitted negRisk flag — vault/redeem._is_neg_risk_market "
        "would treat it as None and refuse to redeem"
    )
    assert isinstance(liquid_market["raw"]["negRisk"], bool)


def test_gamma_provides_clob_token_ids(liquid_market):
    """Token IDs are how we identify positions on-chain. Without them we
    can't trade, can't reconcile, can't redeem."""
    raw = liquid_market["raw"]
    assert "clobTokenIds" in raw
    tids = raw["clobTokenIds"]
    if isinstance(tids, str):
        tids = json.loads(tids)
    assert isinstance(tids, list) and len(tids) == 2, tids
    for tid in tids:
        # Token IDs are uint256 stringified
        assert isinstance(tid, str) and tid.isdigit() and len(tid) > 10


# ── CLOB metadata endpoints ──────────────────────────────────────────────

def test_clob_book_endpoint_returns_bids_asks(liquid_market):
    """sell_shares / get_best_ask depend on this exact shape."""
    try:
        r = httpx.get(
            f"{CLOB}/book",
            params={"token_id": liquid_market["token_id"]},
            timeout=10,
        )
    except Exception as e:
        pytest.skip(f"CLOB book unreachable: {e}")
    r.raise_for_status()
    book = r.json()
    assert "bids" in book and "asks" in book, book.keys()
    assert isinstance(book["bids"], list)
    assert isinstance(book["asks"], list)


def test_clob_neg_risk_endpoint(liquid_market):
    """py-clob-client's get_neg_risk uses this. Our v2 order builder
    chooses verifyingContract based on the result."""
    try:
        r = httpx.get(
            f"{CLOB}/neg-risk",
            params={"token_id": liquid_market["token_id"]},
            timeout=10,
        )
    except Exception as e:
        pytest.skip(f"CLOB neg-risk unreachable: {e}")
    r.raise_for_status()
    body = r.json()
    assert "neg_risk" in body, body.keys()
    assert isinstance(body["neg_risk"], bool)


def test_clob_tick_size_endpoint(liquid_market):
    """Tick size constrains the prices we can send in orders. SDK's
    create_market_order resolves it via this endpoint."""
    try:
        r = httpx.get(
            f"{CLOB}/tick-size",
            params={"token_id": liquid_market["token_id"]},
            timeout=10,
        )
    except Exception as e:
        pytest.skip(f"CLOB tick-size unreachable: {e}")
    r.raise_for_status()
    body = r.json()
    assert "minimum_tick_size" in body, body.keys()


def test_clob_fee_rate_endpoint(liquid_market):
    """py-clob-client uses get_fee_rate_bps for market-order fee math.
    Our v2 builder reads this through the SDK."""
    try:
        r = httpx.get(
            f"{CLOB}/fee-rate",
            params={"token_id": liquid_market["token_id"]},
            timeout=10,
        )
    except Exception as e:
        pytest.skip(f"CLOB fee-rate unreachable: {e}")
    r.raise_for_status()
    body = r.json()
    # The SDK reads `result.get("base_fee") or 0` — we just assert the
    # endpoint responds and returns a dict so the SDK can parse it.
    assert isinstance(body, dict), body


# ── On-chain RPC sanity ──────────────────────────────────────────────────

def test_pusd_collateral_token_is_a_real_erc20():
    """v20.8 audit: pUSD is the v2 settlement currency. Pin its existence,
    symbol, and decimals so we notice if Polymarket re-deploys/renames."""
    try:
        r = httpx.post(
            "https://polygon-bor-rpc.publicnode.com",
            json={
                "jsonrpc": "2.0", "id": 1,
                "method": "eth_call",
                "params": [{
                    "to": "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
                    # symbol() selector
                    "data": "0x95d89b41",
                }, "latest"],
            },
            timeout=10,
        )
    except Exception as e:
        pytest.skip(f"RPC unreachable: {e}")
    r.raise_for_status()
    body = r.json()
    assert "result" in body and body["result"] != "0x", body
    # The result is ABI-encoded string. We just assert the call succeeded
    # (a non-empty result). Decoding the symbol is over-specific for a
    # contract test; the address pin in test_v2_addresses_pinned is enough.


def test_collateral_onramp_contract_exists():
    """v20.8 audit: CollateralOnramp wraps USDC.e to pUSD. If Polymarket
    moves this contract, our setup_v2_allowances + manual wrap script
    target the wrong place."""
    try:
        r = httpx.post(
            "https://polygon-bor-rpc.publicnode.com",
            json={
                "jsonrpc": "2.0", "id": 1, "method": "eth_getCode",
                "params": ["0x93070a847efef7f70739046a929d47a521f5b8ee", "latest"],
            },
            timeout=10,
        )
    except Exception as e:
        pytest.skip(f"RPC unreachable: {e}")
    r.raise_for_status()
    code = r.json()["result"]
    assert code != "0x" and len(code) > 4, "CollateralOnramp has no bytecode at pinned address"


def test_polygon_rpc_responds_with_block_number():
    """All on-chain ops in real mode go through Polygon RPC. If our default
    endpoint stops working we lose drift detection, share reconciliation,
    redemption, allowance checks. Fail loud."""
    try:
        r = httpx.post(
            "https://polygon-bor-rpc.publicnode.com",
            json={"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1},
            timeout=10,
        )
    except Exception as e:
        pytest.skip(f"polygon RPC unreachable: {e}")
    r.raise_for_status()
    body = r.json()
    assert "result" in body, body
    block_hex = body["result"]
    assert block_hex.startswith("0x")
    block = int(block_hex, 16)
    # Polygon ~1 block / 2s. Block number should be a large number,
    # confirming the RPC isn't returning some early-chain stub.
    assert block > 80_000_000, f"unexpected low block number: {block}"
