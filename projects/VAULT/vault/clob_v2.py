"""Polymarket CLOB v2 order signing + posting.

Polymarket migrated their CLOB to protocol v2 around late April 2026
(GET /version returns {"version": 2}). Our installed py-clob-client (0.34.6)
still builds v1 orders, which the server now rejects with
'order_version_mismatch'. The TS SDK (clob-client-v2) has v2 support; the
Python SDK doesn't yet.

This module implements the minimum needed for v2:
- Build the v2 Order struct (11 EIP-712 fields)
- Sign via EIP-712 typed data using eth_account
- POST to /order with the existing L2 HMAC auth headers from py-clob-client

We still use py-clob-client for everything else (auth/API key derivation,
neg_risk lookup, tick_size, fee rate, market-order amount calc, response
parsing). It's purely the order build + sign that we override.

Source of truth for the v2 schema: Polymarket's clob-client-v2 TS repo,
specifically src/order-utils/model/ctfExchangeV2TypedData.ts and
src/order-utils/exchangeOrderBuilderV2.ts.
"""
from __future__ import annotations

import logging
import os
import secrets
import time
from typing import Any

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data
from py_clob_client.headers.headers import create_level_2_headers
from py_clob_client.clob_types import RequestArgs

log = logging.getLogger("vault.clob_v2")

# ── v2 EIP-712 spec ─────────────────────────────────────────────────────────
V2_DOMAIN_NAME = "Polymarket CTF Exchange"
V2_DOMAIN_VERSION = "2"

# Polygon mainnet (chainId=137)
V2_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B"
V2_NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59"
CHAIN_ID = 137

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
ZERO_BYTES32 = "0x" + "00" * 32

# v2 EIP-712 Order struct. Field order matches CTF_EXCHANGE_V2_ORDER_STRUCT
# in the TS SDK exactly — order matters for the typed-data hash.
V2_ORDER_TYPES = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "Order": [
        {"name": "salt", "type": "uint256"},
        {"name": "maker", "type": "address"},
        {"name": "signer", "type": "address"},
        {"name": "tokenId", "type": "uint256"},
        {"name": "makerAmount", "type": "uint256"},
        {"name": "takerAmount", "type": "uint256"},
        {"name": "side", "type": "uint8"},
        {"name": "signatureType", "type": "uint8"},
        {"name": "timestamp", "type": "uint256"},
        {"name": "metadata", "type": "bytes32"},
        {"name": "builder", "type": "bytes32"},
    ],
}


def _generate_salt() -> int:
    """Produce a 256-bit random salt (uint256 fits any value < 2^256)."""
    return int.from_bytes(secrets.token_bytes(32), "big")


def build_signed_order_v2(
    *,
    private_key: str,
    maker: str,
    token_id: str,
    maker_amount: int,
    taker_amount: int,
    side: str,
    signature_type: int = 0,
    neg_risk: bool,
    metadata: str = ZERO_BYTES32,
    builder: str = ZERO_BYTES32,
    expiration: str = "0",
) -> dict:
    """Build + sign a v2 order. Returns the JSON dict ready to POST.

    `side` is "BUY" or "SELL". `signature_type` is 0=EOA, 1=POLY_PROXY,
    2=POLY_GNOSIS_SAFE, 3=POLY_1271 (v2 added POLY_1271).

    `maker_amount` and `taker_amount` are in token-decimal units (1e6 for
    USDC and CTF on Polygon).
    """
    if side not in ("BUY", "SELL"):
        raise ValueError(f"side must be 'BUY' or 'SELL', got {side!r}")

    account = Account.from_key(private_key)
    signer_address = account.address

    side_int = 0 if side == "BUY" else 1
    salt = _generate_salt()
    # Use millisecond timestamp like the TS SDK (Date.now()). The contract
    # treats it as uint256 so the exact unit isn't enforced on-chain, but
    # we must match what the server expects.
    timestamp = int(time.time() * 1000)

    exchange_contract = V2_NEG_RISK_EXCHANGE if neg_risk else V2_EXCHANGE

    domain = {
        "name": V2_DOMAIN_NAME,
        "version": V2_DOMAIN_VERSION,
        "chainId": CHAIN_ID,
        "verifyingContract": exchange_contract,
    }

    message = {
        "salt": salt,
        "maker": maker,
        "signer": signer_address,
        "tokenId": int(token_id),
        "makerAmount": int(maker_amount),
        "takerAmount": int(taker_amount),
        "side": side_int,
        "signatureType": int(signature_type),
        "timestamp": timestamp,
        "metadata": metadata,
        "builder": builder,
    }

    full_message = {
        "types": V2_ORDER_TYPES,
        "primaryType": "Order",
        "domain": domain,
        "message": message,
    }

    signable = encode_typed_data(full_message=full_message)
    signed = account.sign_message(signable)
    signature_hex = signed.signature.hex()
    if not signature_hex.startswith("0x"):
        signature_hex = "0x" + signature_hex

    # JSON shape sent to /order. Mirrors orderToJsonV2 in the TS SDK:
    # `taker` and `expiration` are present in the JSON but NOT in the
    # signed typed data. `side` here is the string form, not the uint8.
    return {
        "salt": str(salt),
        "maker": maker,
        "signer": signer_address,
        "taker": ZERO_ADDRESS,
        "tokenId": str(token_id),
        "makerAmount": str(maker_amount),
        "takerAmount": str(taker_amount),
        "side": side,
        "signatureType": int(signature_type),
        "timestamp": str(timestamp),
        "expiration": expiration,
        "metadata": metadata,
        "builder": builder,
        "signature": signature_hex,
    }


def post_order_v2(
    *,
    client,
    signed_order: dict,
    order_type: str = "FAK",
    post_only: bool = False,
    defer_exec: bool = False,
    host: str = "https://clob.polymarket.com",
    timeout: float = 15.0,
) -> dict:
    """POST a signed v2 order to /order using py-clob-client's L2 auth.

    Returns the parsed JSON response. Caller is responsible for interpreting
    success / trade data — the response shape didn't change from v1.
    """
    import json as _json

    body = {
        "order": signed_order,
        "owner": client.creds.api_key,
        "orderType": order_type,
        "postOnly": post_only,
        "deferExec": defer_exec,
    }
    serialized = _json.dumps(body, separators=(",", ":"), ensure_ascii=False)

    request_args = RequestArgs(
        method="POST",
        request_path="/order",
        body=body,
        serialized_body=serialized,
    )
    headers = create_level_2_headers(client.signer, client.creds, request_args)
    headers["Content-Type"] = "application/json"

    resp = httpx.post(
        f"{host}/order",
        headers=headers,
        content=serialized,
        timeout=timeout,
    )
    if resp.status_code >= 400:
        # Surface the server's error verbatim — the v1-style PolyApiException
        # message format is what the rest of clob_client.py already pattern-
        # matches against (e.g. for the order_version_mismatch detection).
        raise RuntimeError(
            f"PolyApiException[status_code={resp.status_code}, error_message={resp.text}]"
        )
    return resp.json()
