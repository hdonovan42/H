"""On-chain redemption of resolved CTF positions.

After a Polymarket market resolves, the system credits the ledger with the
expected payout (`record_prediction_resolve`). But the cash isn't actually
in the wallet until we call the appropriate redemption contract on-chain.
This module closes that gap.

Until April 2026 the daemon had no redemption path: ledger said cash was
back, wallet still held CTF shares, drift safeguard would catch it eventually
but no automated recovery existed.

Two redemption flows depending on the market's `negRisk` flag:
- neg-risk: NegRiskAdapter.redeemPositions(conditionId, amounts[])
- binary:   ConditionalTokens.redeemPositions(USDC, parent, conditionId, indexSets[])

Both require a one-time setApprovalForAll on the CTF contract. We do that
on-demand the first time we redeem.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

import httpx
from eth_account import Account
from web3 import Web3

from vault.clob_client import (
    CTF_CONTRACT,
    POLYGON_USDC_ADDRESS,
    _call_with_rpc_fallback,
    _ensure_providers,
    get_ctf_balance,
)

log = logging.getLogger("vault.redeem")

# Polymarket contracts on Polygon
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
CONDITIONAL_TOKENS = CTF_CONTRACT  # same address (ConditionalTokens IS the CTF on Polymarket)
ZERO_BYTES32 = "0x" + "00" * 32

CTF_APPROVAL_ABI = [
    {
        "inputs": [{"name": "account", "type": "address"}, {"name": "operator", "type": "address"}],
        "name": "isApprovedForAll",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [{"name": "operator", "type": "address"}, {"name": "approved", "type": "bool"}],
        "name": "setApprovalForAll",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]

NEG_RISK_REDEEM_ABI = [{
    "inputs": [
        {"name": "_conditionId", "type": "bytes32"},
        {"name": "_amounts", "type": "uint256[]"},
    ],
    "name": "redeemPositions",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function",
}]

CT_REDEEM_ABI = [{
    "inputs": [
        {"name": "collateralToken", "type": "address"},
        {"name": "parentCollectionId", "type": "bytes32"},
        {"name": "conditionId", "type": "bytes32"},
        {"name": "indexSets", "type": "uint256[]"},
    ],
    "name": "redeemPositions",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function",
}]

ERC20_BAL_ABI = [{
    "constant": True,
    "inputs": [{"name": "_owner", "type": "address"}],
    "name": "balanceOf",
    "outputs": [{"name": "balance", "type": "uint256"}],
    "type": "function",
}]


def _wallet_account():
    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    if not pk:
        raise RuntimeError("POLYMARKET_PRIVATE_KEY not set")
    return Account.from_key(pk)


def _is_neg_risk_market(market_id: str) -> Optional[bool]:
    """Query Polymarket's gamma API to determine whether a market is neg-risk.
    Returns None on failure (caller should treat as 'unknown — do not redeem')."""
    try:
        r = httpx.get(f"https://gamma-api.polymarket.com/markets/{market_id}", timeout=10)
        r.raise_for_status()
        return bool(r.json().get("negRisk"))
    except Exception as e:
        log.warning(f"Could not determine negRisk for market {market_id}: {e}")
        return None


def _ensure_approval(w3: Web3, account, operator: str) -> Optional[str]:
    """Idempotent setApprovalForAll on the CTF contract. Returns tx hash if a
    new approval was sent, None if already approved."""
    ctf = w3.eth.contract(address=Web3.to_checksum_address(CTF_CONTRACT), abi=CTF_APPROVAL_ABI)
    is_approved = ctf.functions.isApprovedForAll(
        account.address, Web3.to_checksum_address(operator)
    ).call()
    if is_approved:
        return None

    log.info(f"Granting setApprovalForAll for operator {operator}")
    fn = ctf.functions.setApprovalForAll(Web3.to_checksum_address(operator), True)
    gas = fn.estimate_gas({"from": account.address})
    nonce = w3.eth.get_transaction_count(account.address)
    fee_data = w3.eth.fee_history(1, "latest", [50])
    base_fee = fee_data["baseFeePerGas"][-1]
    priority = w3.to_wei(30, "gwei")
    tx = fn.build_transaction({
        "from": account.address,
        "nonce": nonce,
        "gas": int(gas * 1.2),
        "maxFeePerGas": base_fee * 2 + priority,
        "maxPriorityFeePerGas": priority,
        "chainId": 137,
    })
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt["status"] != 1:
        raise RuntimeError(f"approval tx failed: {tx_hash.hex()}")
    return "0x" + tx_hash.hex()


def _usdc_balance_raw(w3: Web3, addr: str) -> int:
    erc = w3.eth.contract(address=Web3.to_checksum_address(POLYGON_USDC_ADDRESS), abi=ERC20_BAL_ABI)
    return erc.functions.balanceOf(Web3.to_checksum_address(addr)).call()


def redeem_prediction(conn, prediction_id: int, *, dry_run: bool = False) -> dict:
    """Redeem a single closed real-mode winning prediction.

    Returns dict with:
      success: bool
      tx_hash: str (if redeemed)
      usdc_received: float (USDC.e delta)
      shares_burned: float (CTF balance before)
      error: str (on failure)

    Idempotent: if the CTF balance for the token is 0, returns success with
    usdc_received=0 (already redeemed).
    """
    pred = conn.execute(
        "SELECT id, market_id, condition_id, side, shares, clob_token_id, "
        "execution_mode, status, payout FROM predictions WHERE id = ?",
        (prediction_id,),
    ).fetchone()
    if pred is None:
        return {"success": False, "error": f"prediction {prediction_id} not found"}
    if pred["execution_mode"] != "real":
        return {"success": False, "error": "not a real-mode prediction"}
    if pred["status"] != "closed":
        return {"success": False, "error": f"prediction not closed (status={pred['status']})"}
    if not pred["condition_id"]:
        return {"success": False, "error": "prediction has no condition_id"}

    # Check on-chain CTF balance first — cheap and may short-circuit the
    # whole flow without needing wallet keys or market metadata.
    onchain_shares = get_ctf_balance(pred["clob_token_id"])
    if onchain_shares is None:
        return {"success": False, "error": "RPC blind — cannot read CTF balance"}
    if onchain_shares <= 0.000001:
        return {
            "success": True,
            "usdc_received": 0.0,
            "shares_burned": 0.0,
            "tx_hash": None,
            "note": "no shares on-chain (already redeemed or never held)",
        }

    # Determine redemption path
    is_neg_risk = _is_neg_risk_market(pred["market_id"])
    if is_neg_risk is None:
        return {"success": False, "error": "could not determine market type (negRisk flag unavailable)"}

    account = _wallet_account()
    addr = account.address

    # We need a Web3 instance with our private key to send txs.
    # The shared rpc_fallback list is used for read calls; for writes we need
    # a stable provider. Try them in order until one accepts the tx.
    _ensure_providers()  # populates _w3_providers in clob_client
    from vault.clob_client import _w3_providers

    last_err = None
    for url, _ in _w3_providers:
        try:
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 20}))

            usdc_before_raw = _usdc_balance_raw(w3, addr)
            shares_raw = int(round(onchain_shares * 1e6))
            condition_bytes = bytes.fromhex(pred["condition_id"].replace("0x", ""))

            if is_neg_risk:
                # NegRiskAdapter.redeemPositions(conditionId, [yesAmount, noAmount])
                # We only own one side; the other is 0.
                yes_token = pred["clob_token_id"]
                # For neg-risk, amounts[] order corresponds to outcome index (YES=0, NO=1)
                amounts = [shares_raw, 0] if pred["side"] == "YES" else [0, shares_raw]
                target = NEG_RISK_ADAPTER
                contract = w3.eth.contract(
                    address=Web3.to_checksum_address(target), abi=NEG_RISK_REDEEM_ABI
                )
                fn = contract.functions.redeemPositions(condition_bytes, amounts)
            else:
                # ConditionalTokens.redeemPositions(USDC, parentCollectionId=0, conditionId, indexSets)
                # indexSets [1, 2] = both outcomes; ConditionalTokens figures out winners
                target = CONDITIONAL_TOKENS
                contract = w3.eth.contract(
                    address=Web3.to_checksum_address(target), abi=CT_REDEEM_ABI
                )
                fn = contract.functions.redeemPositions(
                    Web3.to_checksum_address(POLYGON_USDC_ADDRESS),
                    bytes.fromhex(ZERO_BYTES32.replace("0x", "")),
                    condition_bytes,
                    [1, 2],
                )

            # Dry-run the call first to surface revert reasons cleanly.
            try:
                fn.call({"from": addr})
            except Exception as e:
                # If revert is "need operator approval", set it and retry.
                if "operator approval" in str(e).lower():
                    if dry_run:
                        return {"success": False, "error": f"would need approval first: {e}"}
                    _ensure_approval(w3, account, target)
                    # Retry the call
                    fn.call({"from": addr})
                else:
                    return {"success": False, "error": f"redemption would revert: {e}"}

            if dry_run:
                return {
                    "success": True,
                    "dry_run": True,
                    "would_redeem_shares": onchain_shares,
                    "neg_risk": is_neg_risk,
                    "target": target,
                }

            gas = fn.estimate_gas({"from": addr})
            nonce = w3.eth.get_transaction_count(addr)
            fee_data = w3.eth.fee_history(1, "latest", [50])
            base_fee = fee_data["baseFeePerGas"][-1]
            priority = w3.to_wei(30, "gwei")
            tx = fn.build_transaction({
                "from": addr,
                "nonce": nonce,
                "gas": int(gas * 1.2),
                "maxFeePerGas": base_fee * 2 + priority,
                "maxPriorityFeePerGas": priority,
                "chainId": 137,
            })
            signed = account.sign_transaction(tx)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
            if receipt["status"] != 1:
                return {"success": False, "error": f"tx failed on-chain: {tx_hash.hex()}"}

            time.sleep(2)  # let chain state settle for our balance read
            usdc_after_raw = _usdc_balance_raw(w3, addr)
            usdc_received = (usdc_after_raw - usdc_before_raw) / 1e6

            log.info(
                f"REDEEMED pred #{prediction_id}: {onchain_shares:.4f} shares -> "
                f"${usdc_received:.4f} USDC.e (tx 0x{tx_hash.hex()[:16]}...)"
            )
            return {
                "success": True,
                "tx_hash": "0x" + tx_hash.hex(),
                "usdc_received": round(usdc_received, 6),
                "shares_burned": round(onchain_shares, 6),
                "neg_risk": is_neg_risk,
            }

        except Exception as e:
            last_err = e
            log.warning(f"redemption via {url} failed: {e}")
            continue

    return {"success": False, "error": f"all RPC providers failed: {last_err}"}


def find_redeemable(conn) -> list[dict]:
    """Return closed real-mode winning predictions whose CTF shares are still
    on-chain (i.e. need redeeming). Filters out predictions whose markets
    haven't actually resolved on-chain yet (UMA finalisation delay)."""
    rows = conn.execute(
        "SELECT id, market_id, condition_id, side, clob_token_id, payout "
        "FROM predictions WHERE execution_mode = 'real' AND status = 'closed' "
        "AND payout > 0 AND clob_token_id IS NOT NULL "
        "ORDER BY id"
    ).fetchall()
    out = []
    for r in rows:
        bal = get_ctf_balance(r["clob_token_id"])
        if bal is None:
            continue  # RPC blind, skip this round
        if bal > 0.000001:
            out.append({
                "id": r["id"],
                "market_id": r["market_id"],
                "side": r["side"],
                "shares": bal,
                "expected_payout": r["payout"],
            })
    return out


def redemption_sweep(conn) -> dict:
    """Redeem every closed real-mode prediction whose shares are still on-chain.

    Called periodically by the daemon. Continues past individual failures so a
    single pathological market doesn't block the rest.
    """
    redeemable = find_redeemable(conn)
    if not redeemable:
        return {"redeemed": 0, "failed": 0, "skipped": 0}

    redeemed = 0
    failed = 0
    skipped = 0
    for item in redeemable:
        try:
            result = redeem_prediction(conn, item["id"])
            if result.get("success"):
                if result.get("usdc_received", 0) > 0 or result.get("note"):
                    redeemed += 1
                else:
                    skipped += 1
                # If actual redemption amount differs from the credited payout,
                # write an adjustment ledger entry so cash matches wallet.
                actual = result.get("usdc_received", 0.0)
                expected = item["expected_payout"] or 0.0
                delta = round(actual - expected, 6)
                if abs(delta) > 0.005 and result.get("tx_hash"):
                    last_balance = conn.execute(
                        "SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1"
                    ).fetchone()[0]
                    new_balance = round(last_balance + delta, 6)
                    conn.execute(
                        "INSERT INTO ledger (entry_type, amount, description, "
                        "reference_id, balance_after) VALUES (?, ?, ?, ?, ?)",
                        (
                            "redemption_adjustment",
                            delta,
                            f"Redemption delta for pred #{item['id']}: "
                            f"actual ${actual:.4f} vs credited ${expected:.4f}",
                            item["id"],
                            new_balance,
                        ),
                    )
                    conn.commit()
            else:
                failed += 1
                log.warning(f"Redemption failed for pred #{item['id']}: {result.get('error')}")
        except Exception as e:
            failed += 1
            log.error(f"Redemption raised for pred #{item['id']}: {e}", exc_info=True)

    return {"redeemed": redeemed, "failed": failed, "skipped": skipped}
