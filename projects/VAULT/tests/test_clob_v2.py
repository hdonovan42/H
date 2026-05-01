"""Tests for the CLOB v2 order signer.

Pinned to the late-Apr-2026 Polymarket migration: GET /version started
returning {"version": 2}, the EIP-712 domain version flipped from "1" to
"2", new verifying contracts were deployed, and the Order struct gained
timestamp/metadata/builder while losing nonce/feeRateBps/taker.
"""
import re
from unittest.mock import patch, MagicMock

import pytest
from eth_account import Account

from vault.clob_v2 import (
    build_signed_order_v2,
    V2_DOMAIN_NAME,
    V2_DOMAIN_VERSION,
    V2_EXCHANGE,
    V2_NEG_RISK_EXCHANGE,
    ZERO_ADDRESS,
    ZERO_BYTES32,
)


# Deterministic test key — for unit tests only, never used on-chain.
TEST_PRIVATE_KEY = "0x" + "11" * 32
TEST_ACCOUNT = Account.from_key(TEST_PRIVATE_KEY)


def test_v2_domain_version_is_2_not_1():
    """Regression: v1 used '1', v2 uses '2'. Mixing them yields order_version_mismatch."""
    assert V2_DOMAIN_VERSION == "2"
    # Domain name is unchanged across versions.
    assert V2_DOMAIN_NAME == "Polymarket CTF Exchange"


def test_v2_uses_new_exchange_addresses():
    """Regression: v2 uses different verifyingContract addresses than v1."""
    # These addresses are pinned to the values in Polymarket's clob-client-v2
    # MATIC_CONTRACTS config. If Polymarket migrates again, both checks fail
    # together and the next dev knows to look at the source.
    assert V2_EXCHANGE.lower() == "0xe111180000d2663c0091e4f400237545b87b996b"
    assert V2_NEG_RISK_EXCHANGE.lower() == "0xe2222d279d744050d28e00520010520000310f59"


def test_buy_order_has_correct_shape():
    order = build_signed_order_v2(
        private_key=TEST_PRIVATE_KEY,
        maker=TEST_ACCOUNT.address,
        token_id="123456789",
        maker_amount=1_480_000,
        taker_amount=2_500_000,
        side="BUY",
        neg_risk=False,
    )
    # JSON shape: 11 fields in the EIP-712 message + taker, expiration, signature
    expected_keys = {
        "salt", "maker", "signer", "taker", "tokenId",
        "makerAmount", "takerAmount", "side", "signatureType",
        "timestamp", "expiration", "metadata", "builder", "signature",
    }
    assert set(order.keys()) == expected_keys
    assert order["side"] == "BUY"
    assert order["taker"] == ZERO_ADDRESS
    assert order["expiration"] == "0"
    assert order["metadata"] == ZERO_BYTES32
    assert order["builder"] == ZERO_BYTES32
    # All numeric fields are stringified for JSON safety
    assert isinstance(order["salt"], str)
    assert isinstance(order["makerAmount"], str)
    assert order["maker"] == TEST_ACCOUNT.address
    assert order["signer"] == TEST_ACCOUNT.address
    # Signature is 65 bytes hex (130 chars + 0x prefix)
    assert re.fullmatch(r"0x[0-9a-fA-F]{130}", order["signature"])


def test_sell_order_has_side_sell():
    order = build_signed_order_v2(
        private_key=TEST_PRIVATE_KEY,
        maker=TEST_ACCOUNT.address,
        token_id="123456789",
        maker_amount=2_287_530,
        taker_amount=200_000,
        side="SELL",
        neg_risk=True,
    )
    assert order["side"] == "SELL"


def test_invalid_side_rejected():
    with pytest.raises(ValueError, match="side must be"):
        build_signed_order_v2(
            private_key=TEST_PRIVATE_KEY,
            maker=TEST_ACCOUNT.address,
            token_id="1",
            maker_amount=1,
            taker_amount=1,
            side="HOLD",  # nope
            neg_risk=False,
        )


def test_two_orders_have_different_salts():
    """Salt must be random per order — duplicate salts could be replay vectors."""
    a = build_signed_order_v2(
        private_key=TEST_PRIVATE_KEY,
        maker=TEST_ACCOUNT.address,
        token_id="1",
        maker_amount=1,
        taker_amount=1,
        side="BUY",
        neg_risk=False,
    )
    b = build_signed_order_v2(
        private_key=TEST_PRIVATE_KEY,
        maker=TEST_ACCOUNT.address,
        token_id="1",
        maker_amount=1,
        taker_amount=1,
        side="BUY",
        neg_risk=False,
    )
    assert a["salt"] != b["salt"]
    assert a["signature"] != b["signature"]


def test_neg_risk_market_signs_against_neg_risk_exchange():
    """The verifyingContract differs between regular and neg-risk markets.
    A neg-risk order signed against the regular exchange will reject."""
    # We can't directly inspect the verifying contract from the JSON output
    # (it's part of the typed-data hash, not the JSON). But we can verify
    # that the same inputs with different neg_risk flags produce different
    # signatures — proves they're hashed against different domains.
    args = dict(
        private_key=TEST_PRIVATE_KEY,
        maker=TEST_ACCOUNT.address,
        token_id="1",
        maker_amount=1_000_000,
        taker_amount=1_000_000,
        side="BUY",
    )
    # Force salts to match by patching _generate_salt
    with patch("vault.clob_v2._generate_salt", return_value=42), \
         patch("time.time", return_value=1700000000):
        regular = build_signed_order_v2(**args, neg_risk=False)
        neg_risk = build_signed_order_v2(**args, neg_risk=True)
    assert regular["salt"] == neg_risk["salt"]  # sanity — same salt
    assert regular["timestamp"] == neg_risk["timestamp"]  # same timestamp
    # Signatures must differ because verifyingContract differs
    assert regular["signature"] != neg_risk["signature"]


def test_signature_recovers_to_signer_address():
    """End-to-end check: signing a v2 order with our key should produce a
    signature that recovers to that key's address when verified."""
    from eth_account.messages import encode_typed_data
    from vault.clob_v2 import V2_ORDER_TYPES, V2_DOMAIN_NAME, V2_DOMAIN_VERSION, CHAIN_ID

    order = build_signed_order_v2(
        private_key=TEST_PRIVATE_KEY,
        maker=TEST_ACCOUNT.address,
        token_id="123",
        maker_amount=1_000_000,
        taker_amount=2_000_000,
        side="BUY",
        neg_risk=False,
    )

    # Reconstruct the typed data and recover the signer
    full_message = {
        "types": V2_ORDER_TYPES,
        "primaryType": "Order",
        "domain": {
            "name": V2_DOMAIN_NAME,
            "version": V2_DOMAIN_VERSION,
            "chainId": CHAIN_ID,
            "verifyingContract": V2_EXCHANGE,
        },
        "message": {
            "salt": int(order["salt"]),
            "maker": order["maker"],
            "signer": order["signer"],
            "tokenId": int(order["tokenId"]),
            "makerAmount": int(order["makerAmount"]),
            "takerAmount": int(order["takerAmount"]),
            "side": 0 if order["side"] == "BUY" else 1,
            "signatureType": int(order["signatureType"]),
            "timestamp": int(order["timestamp"]),
            "metadata": order["metadata"],
            "builder": order["builder"],
        },
    }
    signable = encode_typed_data(full_message=full_message)
    recovered = Account.recover_message(signable, signature=order["signature"])
    assert recovered == TEST_ACCOUNT.address
