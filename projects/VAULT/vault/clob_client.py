"""CLOB client — Polymarket order placement via py-clob-client."""

import logging
import os
from dataclasses import dataclass

from vault.config_loader import load_config

log = logging.getLogger("vault.clob")

_client = None
# Ordered list of (url, web3_instance_or_None). Populated lazily; rotated on failure.
_w3_providers: list = []

# Polygon USDC.e (bridged USDC on Polygon PoS) — Polymarket's collateral token
POLYGON_USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
# Native Circle USDC on Polygon — what Coinbase sends by default
POLYGON_NATIVE_USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
# Polymarket CTF (Conditional Token Framework) on Polygon — ERC1155
CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
# Uniswap v3 SwapRouter + Factory on Polygon — used for auto-swapping native→USDC.e
UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564"
UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
UNISWAP_V3_FEE_TIER = 100  # 0.01% — the stable-to-stable pool for USDC/USDC.e
ERC20_BALANCE_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function",
    }
]


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

    kwargs = dict(host=host, key=pk, chain_id=chain_id, signature_type=signature_type)
    if funder:
        kwargs["funder"] = funder
    _client = ClobClient(**kwargs)

    # Derive or load API credentials
    _client.set_api_creds(_client.create_or_derive_api_creds())
    log.info("CLOB client initialised")
    return _client


def _get_rpc_urls() -> list[str]:
    """Return ordered RPC URL list: config fallback list, or single legacy URL."""
    cfg = load_config()
    fallback = cfg.get("trading", {}).get("clob", {}).get("rpc_fallback")
    if isinstance(fallback, list) and fallback:
        return [str(u) for u in fallback if u]
    legacy = cfg.get("polygon_rpc_url")
    if legacy:
        return [legacy]
    return ["https://polygon-bor-rpc.publicnode.com"]


def _ensure_providers():
    """Build Web3 instances for each configured RPC URL on first use."""
    global _w3_providers
    if _w3_providers:
        return
    from web3 import Web3
    _w3_providers = [(url, Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 10}))) for url in _get_rpc_urls()]


def _call_with_rpc_fallback(fn, *, label: str):
    """Invoke `fn(w3)` against each RPC provider in order until one succeeds.

    Raises the last exception if every provider fails. Rotates the successful
    provider to the head of the list so subsequent calls prefer it.
    """
    global _w3_providers
    _ensure_providers()
    last_err = None
    for i, (url, w3) in enumerate(list(_w3_providers)):
        try:
            result = fn(w3)
            # Promote this provider to the front so future calls skip dead ones.
            if i > 0:
                _w3_providers = [(url, w3)] + [p for p in _w3_providers if p[0] != url]
            return result
        except Exception as e:
            last_err = e
            log.warning(f"{label}: RPC provider {url} failed ({e}); trying next")
            continue
    raise RuntimeError(f"{label}: all RPC providers failed ({last_err})")


def _get_usdc_balance_raw() -> int | None:
    """Get on-chain USDC.e balance in raw units (6 decimals).

    Returns integer raw-units on success, or None if ALL RPC providers fail.
    A return of 0 means the wallet genuinely has zero USDC.
    """
    from web3 import Web3
    from eth_account import Account

    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    if not pk:
        return None
    try:
        wallet = Account.from_key(pk).address
    except Exception as e:
        log.error(f"Failed to derive wallet address: {e}")
        return None

    def _call(w3):
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(POLYGON_USDC_ADDRESS),
            abi=ERC20_BALANCE_ABI,
        )
        return int(contract.functions.balanceOf(Web3.to_checksum_address(wallet)).call())

    try:
        return _call_with_rpc_fallback(_call, label="USDC balance")
    except Exception as e:
        log.warning(f"Failed to check on-chain USDC balance: {e}")
        return None


def get_ctf_balance(token_id: str) -> float | None:
    """Check on-chain ERC1155 balance for a specific conditional token.

    Returns shares held (6-decimal scaled), or None on failure (all providers down).
    """
    from web3 import Web3
    from eth_account import Account

    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    if not pk:
        return None
    try:
        wallet = Account.from_key(pk).address
    except Exception as e:
        log.error(f"Failed to derive wallet address: {e}")
        return None

    abi = [{
        "constant": True,
        "inputs": [{"name": "account", "type": "address"}, {"name": "id", "type": "uint256"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "type": "function",
    }]

    def _call(w3):
        contract = w3.eth.contract(address=Web3.to_checksum_address(CTF_CONTRACT), abi=abi)
        return int(contract.functions.balanceOf(Web3.to_checksum_address(wallet), int(token_id)).call())

    try:
        raw = _call_with_rpc_fallback(_call, label=f"CTF balance {str(token_id)[:12]}")
        return round(raw / 1e6, 6)
    except Exception as e:
        log.warning(f"Failed to check CTF balance for {str(token_id)[:12]}: {e}")
        return None


def resolve_token_id(clob_token_ids: list | None, side: str) -> str | None:
    """Resolve CLOB token ID from market data. Index 0=YES, 1=NO."""
    if not clob_token_ids or not isinstance(clob_token_ids, list):
        return None
    idx = 0 if side.upper() == "YES" else 1
    if idx >= len(clob_token_ids):
        return None
    token_id = clob_token_ids[idx]
    return str(token_id) if token_id else None


def get_best_ask(token_id: str) -> float | None:
    """Check the CLOB orderbook for the best (lowest) ask price via raw HTTP."""
    import httpx
    try:
        resp = httpx.get(f"https://clob.polymarket.com/book?token_id={token_id}", timeout=10)
        book = resp.json()
        asks = book.get("asks", [])
        if not asks:
            return None
        return min(float(a["price"]) for a in asks)
    except Exception as e:
        log.warning(f"Failed to check orderbook: {e}")
        return None


def buy_shares(token_id: str, amount_usd: float, max_price: float = 0.99) -> FillResult:
    """Place a FAK (immediate-or-cancel) market buy order. Returns FillResult.

    Switched from FOK to FAK because thin Polymarket markets often can't fully
    absorb a $1-$2 order all-or-nothing. FAK fills what's immediately available
    at price <= max_price and cancels the rest — a partial fill is still useful
    momentum exposure. The two-phase commit in `record_prediction_confirm()`
    handles partial fills correctly (records actual cost_basis and shares).

    CRITICAL: Snapshots both USDC.e and CTF (per-token) balances before the
    order. After the order, if the CLOB response reports no fills we re-check
    the CTF balance — a CTF increase is unambiguous proof the order executed,
    even when post_order succeeds with empty trades or throws after settlement.
    """
    from py_clob_client.order_builder.constants import BUY
    from py_clob_client.clob_types import MarketOrderArgs

    # Snapshot balances BEFORE order — both USDC and per-token CTF.
    # CTF is the authoritative fill signal (CLOB has been observed to return
    # success=true,trades=[] while still settling shares on-chain).
    usdc_before = _get_usdc_balance_raw()
    ctf_before = get_ctf_balance(token_id)

    try:
        client = _get_client()

        order_args = MarketOrderArgs(
            token_id=token_id,
            amount=amount_usd,
            side=BUY,
            price=max_price,
        )

        # Polymarket migrated CLOB to v2 in late April 2026. py-clob-client
        # 0.34.6 still builds v1 orders → server rejects with
        # 'order_version_mismatch'. We use the SDK to compute the correct
        # maker/taker amounts (it knows tick sizes, rounding, fee rate, and
        # neg_risk auto-detection), then re-sign the result for the v2
        # struct + new verifying contracts.
        v1_signed = client.create_market_order(order_args)
        v1 = v1_signed.dict()
        from vault.clob_v2 import build_signed_order_v2, post_order_v2
        v2_order = build_signed_order_v2(
            private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
            maker=v1["maker"],
            token_id=v1["tokenId"],
            maker_amount=int(v1["makerAmount"]),
            taker_amount=int(v1["takerAmount"]),
            side=v1["side"],
            signature_type=int(v1.get("signatureType", 0)),
            neg_risk=client.get_neg_risk(token_id),
        )
        resp = post_order_v2(client=client, signed_order=v2_order, order_type="FAK")

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
            # CLOB reported no fills. The Apr 2026 incident showed this response
            # can lie: CLOB returned success=true,trades=[] while 2.29 CTF shares
            # had actually been minted to the wallet on-chain. Poll CTF balance
            # for ~10s — Polymarket settlement is async and can lag the response
            # by several seconds. Any CTF increase = real fill, regardless of
            # what the CLOB response said.
            import time as _time
            ctf_after = ctf_before
            ctf_delta = 0.0
            for _attempt in range(5):  # 0,2,4,6,8s — covers async settlement window
                _time.sleep(2)
                probe = get_ctf_balance(token_id)
                if probe is not None and ctf_before is not None:
                    ctf_after = probe
                    ctf_delta = probe - ctf_before
                    if ctf_delta > 0.01:
                        break  # confirmed fill, stop polling

            usdc_after = _get_usdc_balance_raw()
            spent = (
                (usdc_before - usdc_after) / 1e6
                if (usdc_before is not None and usdc_after is not None)
                else None
            )

            if ctf_delta > 0.01:
                # CTF increased → order filled. Use the on-chain delta as the
                # source of truth for share count. Cost is the USDC we actually
                # spent (if RPC told us); fall back to ctf_delta * max_price.
                if spent is not None and spent > 0.01:
                    actual_cost = spent
                    avg_price = spent / ctf_delta
                else:
                    actual_cost = round(ctf_delta * max_price, 6)
                    avg_price = max_price
                log.error(
                    f"STEALTH FILL DETECTED: CLOB said no trades but CTF balance "
                    f"increased by {ctf_delta:.4f} shares (USDC delta ${spent if spent is not None else '?'}). "
                    f"Order {order_id[:8]} actually executed."
                )
                return FillResult(
                    success=True,
                    order_id=order_id,
                    side="BUY",
                    token_id=token_id,
                    amount_usd=round(actual_cost, 6),
                    shares=round(ctf_delta, 6),
                    avg_price=round(avg_price, 6),
                )

            if ctf_before is None or ctf_after is None:
                # CTF RPC was blind for the whole window — cannot prove no-fill.
                # Refuse to declare cancellation; surface as reconciling-grade
                # failure so the orphan sweep takes another look.
                log.critical(
                    f"STEALTH CHECK BLIND on CTF: CLOB reported no trades for order {order_id[:8]} "
                    f"and CTF balance unavailable (before={ctf_before}, after={ctf_after}). "
                    f"Treating as reconciliation pending — orphan sweep will resolve."
                )
                return FillResult(
                    success=False,
                    error="UNVERIFIED: CLOB reported no fills but on-chain CTF check unavailable",
                )

            if spent is not None and spent > 0.01:
                # USDC moved but CTF did not — money left the wallet without
                # producing shares for this token. Treat as serious anomaly,
                # do NOT silently cancel.
                log.critical(
                    f"ANOMALY: order {order_id[:8]} reported no fills, CTF balance "
                    f"unchanged, but ${spent:.2f} USDC left the wallet. "
                    f"Refusing to cancel — manual investigation required."
                )
                return FillResult(
                    success=False,
                    error=f"UNVERIFIED: USDC moved ${spent:.2f} without matching CTF mint",
                )

            # CTF unchanged AND USDC unchanged → genuine no-fill.
            return FillResult(success=False, error="FAK order accepted but no immediate liquidity at limit")

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
        # CRITICAL: Check if USDC actually left the wallet despite the exception.
        # py-clob-client can throw after the order already executed on-chain.
        usdc_after = _get_usdc_balance_raw()
        if usdc_before is not None and usdc_after is not None:
            spent = (usdc_before - usdc_after) / 1e6
            if spent > 0.01:
                log.error(
                    f"STEALTH FILL DETECTED: post_order threw '{e}' but ${spent:.2f} USDC "
                    f"left the wallet. Treating as successful fill."
                )
                return FillResult(
                    success=True,
                    order_id="stealth-fill",
                    side="BUY",
                    token_id=token_id,
                    amount_usd=round(spent, 6),
                    shares=round(spent / max_price, 6),
                    avg_price=max_price,
                )
        else:
            log.critical(
                f"STEALTH CHECK BLIND: post_order threw '{e}' and RPC balance unavailable "
                f"(before={usdc_before}, after={usdc_after}). Position MAY be on-chain without a record; "
                f"reconciliation sweep will handle."
            )
        log.error(f"CLOB buy error: {e}", exc_info=True)
        return FillResult(success=False, error=str(e))


def sell_shares(token_id: str, shares: float, min_price: float = 0.01) -> FillResult:
    """Place a FAK market sell order. Returns FillResult with fill data.

    CRITICAL: Snapshots on-chain USDC balance before and after to detect
    stealth fills where post_order throws but the order actually executed.
    """
    from py_clob_client.order_builder.constants import SELL
    from py_clob_client.clob_types import MarketOrderArgs

    # Snapshot USDC balance BEFORE order
    usdc_before = _get_usdc_balance_raw()

    try:
        client = _get_client()

        order_args = MarketOrderArgs(
            token_id=token_id,
            amount=shares,
            side=SELL,
            price=min_price,
        )

        # v2 path — see comment in buy_shares for context.
        v1_signed = client.create_market_order(order_args)
        v1 = v1_signed.dict()
        from vault.clob_v2 import build_signed_order_v2, post_order_v2
        v2_order = build_signed_order_v2(
            private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
            maker=v1["maker"],
            token_id=v1["tokenId"],
            maker_amount=int(v1["makerAmount"]),
            taker_amount=int(v1["takerAmount"]),
            side=v1["side"],
            signature_type=int(v1.get("signatureType", 0)),
            neg_risk=client.get_neg_risk(token_id),
        )
        resp = post_order_v2(client=client, signed_order=v2_order, order_type="FAK")

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
            usdc_after = _get_usdc_balance_raw()
            if usdc_before is not None and usdc_after is not None:
                received = (usdc_after - usdc_before) / 1e6
                if received > 0.01:
                    log.error(
                        f"STEALTH FILL DETECTED: response said no trades but ${received:.2f} USDC "
                        f"arrived. Order {order_id[:8]} actually executed."
                    )
                    return FillResult(
                        success=True,
                        order_id=order_id,
                        side="SELL",
                        token_id=token_id,
                        amount_usd=round(received, 6),
                        shares=round(shares, 6),
                        avg_price=round(received / shares, 6) if shares > 0 else 0,
                    )
            else:
                log.critical(
                    f"STEALTH CHECK BLIND on sell: CLOB reported no trades for order {order_id[:8]} "
                    f"and RPC unavailable. Reconciliation sweep will handle."
                )
            return FillResult(success=False, error="FAK sell accepted but no immediate liquidity at limit")

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
        usdc_after = _get_usdc_balance_raw()
        if usdc_before is not None and usdc_after is not None:
            received = (usdc_after - usdc_before) / 1e6
            if received > 0.01:
                log.error(
                    f"STEALTH FILL DETECTED: post_order threw '{e}' but ${received:.2f} USDC "
                    f"arrived. Treating as successful sell."
                )
                return FillResult(
                    success=True,
                    order_id="stealth-fill",
                    side="SELL",
                    token_id=token_id,
                    amount_usd=round(received, 6),
                    shares=round(shares, 6),
                    avg_price=round(received / shares, 6) if shares > 0 else 0,
                )
        else:
            log.critical(
                f"STEALTH CHECK BLIND on sell: post_order threw '{e}' and RPC unavailable. "
                f"Reconciliation sweep will handle."
            )
        log.error(f"CLOB sell error: {e}", exc_info=True)
        return FillResult(success=False, error=str(e))


def get_usdc_balance() -> float | None:
    """Check on-chain USDC.e balance. Returns None if all RPC providers fail.

    A return of 0.0 means the wallet is genuinely empty. Never confuse the two:
    callers treating None as "zero" is how the 15 March incident happened.
    """
    raw = _get_usdc_balance_raw()
    if raw is None:
        return None
    return round(raw / 1e6, 6)


CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
NEG_RISK_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a"


def check_onchain_allowance() -> dict:
    """Query USDC allowance directly on-chain for the Polymarket exchange contracts.

    Ground-truth check — `py-clob-client.get_balance_allowance()` has proven
    unreliable (reports 0 when on-chain allowance is actually MAX), so we read
    from the USDC contract directly using the multi-provider RPC fallback.
    """
    from web3 import Web3
    from eth_account import Account

    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    if not pk:
        return {"balance": None, "allowance": None, "error": "no private key"}
    try:
        wallet = Account.from_key(pk).address
    except Exception as e:
        return {"balance": None, "allowance": None, "error": f"derive wallet failed: {e}"}

    ERC20_ALLOWANCE_ABI = ERC20_BALANCE_ABI + [{
        "constant": True,
        "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
        "name": "allowance",
        "outputs": [{"name": "", "type": "uint256"}],
        "type": "function",
    }]

    def _call(w3):
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(POLYGON_USDC_ADDRESS),
            abi=ERC20_ALLOWANCE_ABI,
        )
        wallet_cs = Web3.to_checksum_address(wallet)
        bal = int(contract.functions.balanceOf(wallet_cs).call())
        ctf_al = int(contract.functions.allowance(wallet_cs, Web3.to_checksum_address(CTF_EXCHANGE_ADDRESS)).call())
        neg_al = int(contract.functions.allowance(wallet_cs, Web3.to_checksum_address(NEG_RISK_EXCHANGE_ADDRESS)).call())
        return bal, ctf_al, neg_al

    try:
        bal, ctf_al, neg_al = _call_with_rpc_fallback(_call, label="allowance check")
    except Exception as e:
        return {"balance": None, "allowance": None, "error": str(e)}

    return {
        "balance": round(bal / 1e6, 6),
        "ctf_exchange_allowance": round(ctf_al / 1e6, 6),
        "neg_risk_exchange_allowance": round(neg_al / 1e6, 6),
        # `allowance` = min of the two, because both must be set to trade all market types
        "allowance": round(min(ctf_al, neg_al) / 1e6, 6),
    }


def get_native_usdc_balance() -> float | None:
    """Get on-chain balance of Circle's native Polygon USDC (what Coinbase sends).

    Returns None if all RPC providers fail, 0.0 if genuinely empty.
    """
    from web3 import Web3
    from eth_account import Account

    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    if not pk:
        return None
    try:
        wallet = Account.from_key(pk).address
    except Exception:
        return None

    def _call(w3):
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(POLYGON_NATIVE_USDC_ADDRESS),
            abi=ERC20_BALANCE_ABI,
        )
        return int(contract.functions.balanceOf(Web3.to_checksum_address(wallet)).call())

    try:
        raw = _call_with_rpc_fallback(_call, label="native USDC balance")
        return round(raw / 1e6, 6)
    except Exception as e:
        log.warning(f"Failed to check native USDC balance: {e}")
        return None


def swap_native_to_bridged_usdc(amount_usdc: float, slippage_bps: int = 50) -> dict:
    """Swap native USDC → USDC.e via Uniswap v3 (fee-tier 100, stable-to-stable pool).

    Used by the auto-swap reconciliation step — when Coinbase-style native USDC
    arrives in the wallet, this converts it to the bridged USDC.e form that
    Polymarket's CLOB requires.

    Idempotent on approval: checks current allowance and only approves if insufficient.
    Returns a dict: {'success', 'amount_in', 'amount_out', 'tx_hash', 'gas_cost_matic', 'error'}.

    `slippage_bps` is basis points (50 = 0.5% max slippage). For stable-to-stable
    on a deep pool, actual slippage is typically <0.01%; the 0.5% default is headroom.
    """
    import time
    from web3 import Web3
    from eth_account import Account

    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    if not pk:
        return {"success": False, "error": "POLYMARKET_PRIVATE_KEY not set"}

    try:
        acct = Account.from_key(pk)
    except Exception as e:
        return {"success": False, "error": f"derive wallet failed: {e}"}
    addr = acct.address

    # Safety: need MATIC for gas (minimum ~$0.01 of gas needed for approve + swap)
    def _matic_balance(w3):
        return int(w3.eth.get_balance(Web3.to_checksum_address(addr)))
    try:
        matic_wei = _call_with_rpc_fallback(_matic_balance, label="MATIC balance")
    except Exception as e:
        return {"success": False, "error": f"RPC unavailable for MATIC check: {e}"}
    if matic_wei < int(0.01 * 1e18):
        return {"success": False, "error": f"insufficient MATIC for gas ({matic_wei/1e18:.4f}, need >= 0.01)"}

    amount_in_raw = int(round(amount_usdc * 1e6))
    min_out_raw = int(amount_in_raw * (10_000 - slippage_bps) / 10_000)

    # ABIs (minimal)
    erc20_abi = [
        {"constant": True, "inputs": [{"name":"owner","type":"address"}], "name":"balanceOf", "outputs":[{"name":"","type":"uint256"}], "type":"function"},
        {"constant": True, "inputs": [{"name":"owner","type":"address"},{"name":"spender","type":"address"}], "name":"allowance", "outputs":[{"name":"","type":"uint256"}], "type":"function"},
        {"inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}], "name":"approve", "outputs":[{"name":"","type":"bool"}], "stateMutability":"nonpayable", "type":"function"},
    ]
    router_abi = [{"inputs":[{"components":[
        {"name":"tokenIn","type":"address"}, {"name":"tokenOut","type":"address"},
        {"name":"fee","type":"uint24"}, {"name":"recipient","type":"address"},
        {"name":"deadline","type":"uint256"}, {"name":"amountIn","type":"uint256"},
        {"name":"amountOutMinimum","type":"uint256"}, {"name":"sqrtPriceLimitX96","type":"uint160"},
    ],"name":"params","type":"tuple"}], "name":"exactInputSingle",
        "outputs":[{"name":"amountOut","type":"uint256"}], "stateMutability":"payable", "type":"function"}]

    # Use a single provider for TX sends (the multi-provider fallback is only for reads;
    # for signed txs we pin to the first working provider to avoid nonce confusion across nodes).
    _ensure_providers()
    if not _w3_providers:
        return {"success": False, "error": "no RPC providers configured"}

    for rpc_url, w3 in _w3_providers:
        try:
            # Quick liveness check
            w3.eth.block_number
        except Exception as e:
            log.warning(f"swap: RPC {rpc_url} dead ({e}); trying next")
            continue

        native = w3.eth.contract(address=Web3.to_checksum_address(POLYGON_NATIVE_USDC_ADDRESS), abi=erc20_abi)
        bridged = w3.eth.contract(address=Web3.to_checksum_address(POLYGON_USDC_ADDRESS), abi=erc20_abi)
        router = w3.eth.contract(address=Web3.to_checksum_address(UNISWAP_V3_ROUTER), abi=router_abi)

        # Sanity: balance must cover amount_in
        bal_native = native.functions.balanceOf(Web3.to_checksum_address(addr)).call()
        if bal_native < amount_in_raw:
            return {"success": False, "error": f"insufficient native USDC: have ${bal_native/1e6:.4f}, need ${amount_usdc:.4f}"}

        try:
            bridged_before = bridged.functions.balanceOf(Web3.to_checksum_address(addr)).call()
            matic_before = matic_wei

            # Approve if needed
            allowance = native.functions.allowance(Web3.to_checksum_address(addr), Web3.to_checksum_address(UNISWAP_V3_ROUTER)).call()
            if allowance < amount_in_raw:
                log.info(f"Auto-swap: approving Uniswap router (current allowance {allowance/1e6:.2f})")
                gas_price = int(w3.eth.gas_price * 1.2)
                approve_tx = native.functions.approve(
                    Web3.to_checksum_address(UNISWAP_V3_ROUTER), 2**256 - 1
                ).build_transaction({
                    "from": Web3.to_checksum_address(addr),
                    "nonce": w3.eth.get_transaction_count(Web3.to_checksum_address(addr)),
                    "gasPrice": gas_price,
                    "gas": 100_000,
                })
                signed = acct.sign_transaction(approve_tx)
                h = w3.eth.send_raw_transaction(signed.raw_transaction)
                r = w3.eth.wait_for_transaction_receipt(h, timeout=120)
                if r.status != 1:
                    return {"success": False, "error": f"approve tx reverted (0x{h.hex()})"}
                log.info(f"Auto-swap: approval confirmed (0x{h.hex()[:10]})")
                # Brief settle so the next node's nonce tracker catches up
                time.sleep(2)

            # Swap
            deadline = int(time.time()) + 300
            gas_price = int(w3.eth.gas_price * 1.2)
            params = (
                Web3.to_checksum_address(POLYGON_NATIVE_USDC_ADDRESS),
                Web3.to_checksum_address(POLYGON_USDC_ADDRESS),
                UNISWAP_V3_FEE_TIER,
                Web3.to_checksum_address(addr),
                deadline,
                amount_in_raw,
                min_out_raw,
                0,
            )
            swap_tx = router.functions.exactInputSingle(params).build_transaction({
                "from": Web3.to_checksum_address(addr),
                "nonce": w3.eth.get_transaction_count(Web3.to_checksum_address(addr)),
                "gasPrice": gas_price,
                "gas": 250_000,
                "value": 0,
            })
            signed = acct.sign_transaction(swap_tx)
            h = w3.eth.send_raw_transaction(signed.raw_transaction)
            log.info(f"Auto-swap: swap tx 0x{h.hex()[:10]}")
            r = w3.eth.wait_for_transaction_receipt(h, timeout=180)
            if r.status != 1:
                return {"success": False, "error": f"swap tx reverted (0x{h.hex()})"}

            bridged_after = bridged.functions.balanceOf(Web3.to_checksum_address(addr)).call()
            matic_after = w3.eth.get_balance(Web3.to_checksum_address(addr))
            amount_out = (bridged_after - bridged_before) / 1e6
            gas_cost = (matic_before - matic_after) / 1e18

            return {
                "success": True,
                "amount_in": amount_usdc,
                "amount_out": round(amount_out, 6),
                "tx_hash": "0x" + h.hex(),
                "gas_cost_matic": round(gas_cost, 6),
            }
        except Exception as e:
            log.error(f"swap via {rpc_url} failed: {e}")
            continue

    return {"success": False, "error": "all RPC providers failed for swap"}


def check_allowances() -> dict:
    """Check exchange contract allowances. Uses on-chain reads (authoritative).

    The CLOB API wrapper (`client.get_balance_allowance`) has been observed to
    report 0 when the actual on-chain allowance is MAX. This helper now bypasses
    that and reads the ERC20 contract directly.
    """
    return check_onchain_allowance()


def setup_allowances():
    """One-time approval for USDC + CTF token exchange contracts."""
    from py_clob_client.clob_types import BalanceAllowanceParams, AssetType

    client = _get_client()
    cfg = load_config()
    sig_type = cfg.get("trading", {}).get("clob", {}).get("signature_type", 0)

    log.info("Setting up exchange allowances...")

    try:
        client.update_balance_allowance(BalanceAllowanceParams(
            asset_type=AssetType.COLLATERAL,
            signature_type=sig_type,
        ))
        log.info("Collateral (USDC) allowance approved")
        return {"success": True}
    except Exception as e:
        log.error(f"Failed to set allowances: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
