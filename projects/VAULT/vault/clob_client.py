"""CLOB client — Polymarket order placement via py-clob-client."""

import logging
import os
from dataclasses import dataclass

from vault.config_loader import load_config

log = logging.getLogger("vault.clob")

_client = None


@dataclass
class FillResult:
    """Result of a CLOB order attempt."""
    success: bool
    order_id: str | None = None
    side: str | None = None
    token_id: str | None = None
    amount_usd: float = 0.0
    shares: float = 0.0
    avg_price: float = 0.0
    error: str | None = None


def _get_client():
    """Lazy singleton — init CLOB client on first use."""
    global _client
    if _client is not None:
        return _client

    from py_clob_client.client import ClobClient

    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    funder = os.environ.get("POLYMARKET_FUNDER_ADDRESS")
    if not pk:
        raise RuntimeError("POLYMARKET_PRIVATE_KEY not set in environment")

    cfg = load_config()
    clob_cfg = cfg.get("trading", {}).get("clob", {})
    host = clob_cfg.get("host", "https://clob.polymarket.com")
    chain_id = clob_cfg.get("chain_id", 137)
    signature_type = clob_cfg.get("signature_type", 0)

    _client = ClobClient(
        host,
        key=pk,
        chain_id=chain_id,
        signature_type=signature_type,
        funder=funder,
    )

    # Derive or load API credentials
    _client.set_api_creds(_client.create_or_derive_api_creds())
    log.info("CLOB client initialised")
    return _client


def resolve_token_id(clob_token_ids: list | None, side: str) -> str | None:
    """Resolve CLOB token ID from market data. Index 0=YES, 1=NO."""
    if not clob_token_ids or not isinstance(clob_token_ids, list):
        return None
    idx = 0 if side.upper() == "YES" else 1
    if idx >= len(clob_token_ids):
        return None
    token_id = clob_token_ids[idx]
    return str(token_id) if token_id else None


def buy_shares(token_id: str, amount_usd: float, max_price: float = 0.99) -> FillResult:
    """Place a FOK market buy order. Returns FillResult with fill data."""
    from py_clob_client.order_builder.constants import BUY

    try:
        client = _get_client()

        order_args = {
            "token_id": token_id,
            "amount": amount_usd,
            "side": BUY,
            "price": max_price,
        }

        signed_order = client.create_market_order(order_args)
        resp = client.post_order(signed_order, "FOK")

        if not resp or not resp.get("success"):
            error_msg = resp.get("errorMsg", "Unknown CLOB error") if resp else "No response from CLOB"
            log.warning(f"CLOB buy failed: {error_msg}")
            return FillResult(success=False, error=error_msg)

        # Parse fill data from response
        order_id = resp.get("orderID", "")
        trades = resp.get("trades", []) or []

        total_shares = 0.0
        total_cost = 0.0
        for trade in trades:
            trade_shares = float(trade.get("size", 0))
            trade_price = float(trade.get("price", 0))
            total_shares += trade_shares
            total_cost += trade_shares * trade_price

        if total_shares <= 0:
            return FillResult(success=False, error="Order accepted but no fills (FOK rejected)")

        avg_price = total_cost / total_shares if total_shares > 0 else 0.0

        log.info(
            f"CLOB BUY filled: {total_shares:.4f} shares @ avg {avg_price:.4f} "
            f"= ${total_cost:.2f} (order {order_id[:8]})"
        )

        return FillResult(
            success=True,
            order_id=order_id,
            side="BUY",
            token_id=token_id,
            amount_usd=round(total_cost, 6),
            shares=round(total_shares, 6),
            avg_price=round(avg_price, 6),
        )

    except Exception as e:
        log.error(f"CLOB buy error: {e}", exc_info=True)
        return FillResult(success=False, error=str(e))


def sell_shares(token_id: str, shares: float, min_price: float = 0.01) -> FillResult:
    """Place a FOK market sell order. Returns FillResult with fill data."""
    from py_clob_client.order_builder.constants import SELL

    try:
        client = _get_client()

        order_args = {
            "token_id": token_id,
            "amount": shares,
            "side": SELL,
            "price": min_price,
        }

        signed_order = client.create_market_order(order_args)
        resp = client.post_order(signed_order, "FOK")

        if not resp or not resp.get("success"):
            error_msg = resp.get("errorMsg", "Unknown CLOB error") if resp else "No response from CLOB"
            log.warning(f"CLOB sell failed: {error_msg}")
            return FillResult(success=False, error=error_msg)

        order_id = resp.get("orderID", "")
        trades = resp.get("trades", []) or []

        total_shares = 0.0
        total_value = 0.0
        for trade in trades:
            trade_shares = float(trade.get("size", 0))
            trade_price = float(trade.get("price", 0))
            total_shares += trade_shares
            total_value += trade_shares * trade_price

        if total_shares <= 0:
            return FillResult(success=False, error="Sell order accepted but no fills (FOK rejected)")

        avg_price = total_value / total_shares if total_shares > 0 else 0.0

        log.info(
            f"CLOB SELL filled: {total_shares:.4f} shares @ avg {avg_price:.4f} "
            f"= ${total_value:.2f} (order {order_id[:8]})"
        )

        return FillResult(
            success=True,
            order_id=order_id,
            side="SELL",
            token_id=token_id,
            amount_usd=round(total_value, 6),
            shares=round(total_shares, 6),
            avg_price=round(avg_price, 6),
        )

    except Exception as e:
        log.error(f"CLOB sell error: {e}", exc_info=True)
        return FillResult(success=False, error=str(e))


def get_usdc_balance() -> float:
    """Check on-chain USDC (collateral) balance."""
    from py_clob_client.clob_types import BalanceAllowanceParams, AssetType

    try:
        client = _get_client()
        cfg = load_config()
        sig_type = cfg.get("trading", {}).get("clob", {}).get("signature_type", 0)
        params = BalanceAllowanceParams(
            asset_type=AssetType.COLLATERAL,
            signature_type=sig_type,
        )
        result = client.get_balance_allowance(params)
        if isinstance(result, dict):
            return float(result.get("balance", 0)) / 1e6  # USDC has 6 decimals
        return 0.0
    except Exception as e:
        log.warning(f"Failed to check USDC balance: {e}")
        return 0.0


def check_allowances() -> dict:
    """Check exchange contract allowances for collateral (USDC)."""
    from py_clob_client.clob_types import BalanceAllowanceParams, AssetType

    try:
        client = _get_client()
        cfg = load_config()
        sig_type = cfg.get("trading", {}).get("clob", {}).get("signature_type", 0)
        params = BalanceAllowanceParams(
            asset_type=AssetType.COLLATERAL,
            signature_type=sig_type,
        )
        result = client.get_balance_allowance(params)
        if isinstance(result, dict):
            return {
                "balance": float(result.get("balance", 0)) / 1e6,
                "allowance": float(result.get("allowance", 0)) / 1e6,
            }
        return {"balance": 0.0, "allowance": 0.0}
    except Exception as e:
        log.warning(f"Failed to check allowances: {e}")
        return {"balance": 0.0, "allowance": 0.0, "error": str(e)}


def setup_allowances():
    """One-time approval for USDC + CTF token exchange contracts.

    Uses py-clob-client's update_balance_allowance to set max approvals.
    """
    from py_clob_client.clob_types import BalanceAllowanceParams, AssetType

    client = _get_client()
    cfg = load_config()
    sig_type = cfg.get("trading", {}).get("clob", {}).get("signature_type", 0)

    log.info("Setting up exchange allowances...")

    try:
        # Approve collateral (USDC)
        client.update_balance_allowance(BalanceAllowanceParams(
            asset_type=AssetType.COLLATERAL,
            signature_type=sig_type,
        ))
        log.info("Collateral (USDC) allowance approved")

        # Conditional token approvals happen per-token when trading
        # (ERC1155 requires a specific token_id, not a blanket approval)
        log.info("Conditional token approvals will be handled per-market at trade time")

        return {"success": True}
    except Exception as e:
        log.error(f"Failed to set allowances: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
