"""Wallet-level cashflow tracking.

Queries Polygon for ERC20 Transfer events touching our wallet on USDC and
USDC.e, filters out internal counterparties (Polymarket exchanges, our own
DEX swaps), and records genuine external deposits/withdrawals to the
`wallet_transactions` table + the ledger.

Semantics:
    - Incoming Transfer where `from` is NOT a known internal address → deposit
    - Outgoing Transfer where `to` is NOT a known internal address → withdrawal
    - Everything else (bets to CTF Exchange, payouts from it, auto-swap
      conversions via Uniswap) is internal and skipped.

Stored in `wallet_transactions`; a corresponding ledger entry is also written
so the internal balance tracks wallet reality 1:1.
"""

import logging
import os
from datetime import datetime, timezone

from vault import ledger
from vault.db import get_meta, set_meta

log = logging.getLogger("vault.wallet_sync")

# Internal counterparties — transfers to/from these are system activity, not cashflow.
# Addresses are stored lowercase; comparisons normalise to lowercase.
INTERNAL_ADDRESSES = {
    # Polymarket exchanges (trades, payouts)
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e": "Polymarket CTF Exchange",
    "0xc5d563a36ae78145c45a50134d48a1215220f80a": "Polymarket Neg-Risk Exchange",
    # Conditional Token Framework — not relevant for USDC but safe to exclude
    "0x4d97dcd97ec945f40cf65f87097ace5ea0476045": "Polymarket CTF",
    # Uniswap v3 infra used for native → USDC.e auto-swap
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap v3 Router",
    "0xd36ec33c8bed5a9f7b6630855f1533455b98a418": "Uniswap v3 USDC/USDC.e Pool (fee=100)",
    "0xd9abecb39a5885d1e531ed3599adfed620e2fc8a": "Uniswap v3 USDC/USDC.e Pool (fee=500)",
}

# Transfer(address,address,uint256) event topic
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# How many blocks to scan per cycle at most (Polygon does ~1 block / 2s;
# 10,000 blocks ≈ 5.5 hours so this is plenty per reconcile).
MAX_BLOCKS_PER_SYNC = 10_000


def _pad_addr(addr: str) -> str:
    """Pad a 20-byte address to a 32-byte topic hex string (left-zero-filled)."""
    return "0x" + "0" * 24 + addr.lower().replace("0x", "")


def _topic_to_addr(topic: str) -> str:
    """Extract the last 20 bytes of a 32-byte topic and format as 0x-address."""
    return "0x" + topic[-40:].lower()


def _label_counterparty(addr: str) -> str:
    """Return the known human label for `addr`, or the raw address (lowercased) if unknown."""
    return INTERNAL_ADDRESSES.get(addr.lower(), addr.lower())


def _is_internal(addr: str) -> bool:
    return addr.lower() in INTERNAL_ADDRESSES


def sync_wallet_transactions(conn) -> dict:
    """Scan new blocks for Transfer events touching our wallet; record external flows.

    Idempotent on re-run — rows keyed by `tx_hash + log_index` via a unique tx_hash
    constraint (one wallet_transaction per tx; multi-transfer txs are coalesced).

    Returns summary dict: {'deposits': n, 'withdrawals': n, 'skipped_internal': n, 'scanned_from': b, 'scanned_to': b}.
    """
    from vault.clob_client import (
        POLYGON_USDC_ADDRESS,
        POLYGON_NATIVE_USDC_ADDRESS,
        _call_with_rpc_fallback,
    )
    from web3 import Web3
    from eth_account import Account

    pk = os.environ.get("POLYMARKET_PRIVATE_KEY")
    if not pk:
        return {"error": "POLYMARKET_PRIVATE_KEY not set"}

    try:
        wallet = Account.from_key(pk).address
    except Exception as e:
        return {"error": f"derive wallet failed: {e}"}
    wallet_lc = wallet.lower()
    wallet_topic = _pad_addr(wallet)

    # Resolve scan window
    def _get_block(w3):
        return int(w3.eth.block_number)
    try:
        latest = _call_with_rpc_fallback(_get_block, label="block number")
    except Exception as e:
        return {"error": f"RPC unavailable: {e}"}

    last_scanned_str = get_meta(conn, "wallet_tx_last_scanned_block")
    if last_scanned_str is None:
        # First run — start from current block (don't scan history).
        set_meta(conn, "wallet_tx_last_scanned_block", str(latest))
        conn.commit()
        log.info(f"Wallet sync initialised: tracking from block {latest}")
        return {"deposits": 0, "withdrawals": 0, "skipped_internal": 0,
                "scanned_from": latest, "scanned_to": latest}

    from_block = int(last_scanned_str) + 1
    to_block = min(latest, from_block + MAX_BLOCKS_PER_SYNC - 1)
    if to_block < from_block:
        return {"deposits": 0, "withdrawals": 0, "skipped_internal": 0,
                "scanned_from": from_block, "scanned_to": to_block}

    # Fetch Transfer logs for both USDC and USDC.e, incoming + outgoing
    tokens = [
        (POLYGON_USDC_ADDRESS, "USDC"),
        (POLYGON_USDC_ADDRESS.lower(), "USDC.e"),  # placeholder — overwritten below
    ]
    # Fix: proper (address, label) pairs
    tokens = [
        (POLYGON_USDC_ADDRESS, "USDC.e"),
        (POLYGON_NATIVE_USDC_ADDRESS, "USDC"),
    ]

    all_logs = []
    for token_addr, token_label in tokens:
        for topic_slot, direction_hint in [("topic1", "from"), ("topic2", "to")]:
            # topic1 = indexed `from`, topic2 = indexed `to` in the Transfer event
            filter_params = {
                "fromBlock": hex(from_block),
                "toBlock": hex(to_block),
                "address": Web3.to_checksum_address(token_addr),
                "topics": [TRANSFER_TOPIC, None, None],
            }
            idx = 1 if topic_slot == "topic1" else 2
            filter_params["topics"][idx] = wallet_topic

            def _get_logs(w3, fp=filter_params):
                return w3.eth.get_logs(fp)
            try:
                logs = _call_with_rpc_fallback(_get_logs, label=f"{token_label} {direction_hint}")
            except Exception as e:
                log.warning(f"Wallet sync: log fetch for {token_label} {direction_hint} failed: {e}")
                return {"error": f"log fetch failed: {e}", "scanned_from": from_block}
            for lg in logs:
                all_logs.append((lg, token_label))

    deposits = 0
    withdrawals = 0
    skipped_internal = 0
    # Coalesce by tx_hash: a single tx can emit multiple Transfers (e.g. the swap
    # emits two, the bet emits one + one from the CTF side). We want one
    # wallet_transactions row per tx reflecting the NET external flow in USDC terms.
    by_tx: dict[str, dict] = {}

    for lg, token_label in all_logs:
        tx_hash = lg["transactionHash"].hex() if hasattr(lg["transactionHash"], "hex") else lg["transactionHash"]
        if not tx_hash.startswith("0x"):
            tx_hash = "0x" + tx_hash
        block_number = int(lg["blockNumber"])

        topics = lg["topics"]
        from_addr = _topic_to_addr(topics[1].hex() if hasattr(topics[1], "hex") else topics[1])
        to_addr = _topic_to_addr(topics[2].hex() if hasattr(topics[2], "hex") else topics[2])
        # value is in data (32 bytes, USDC/USDC.e use 6 decimals)
        data = lg["data"].hex() if hasattr(lg["data"], "hex") else lg["data"]
        if not data.startswith("0x"):
            data = "0x" + data
        value_raw = int(data, 16)
        value_usd = value_raw / 1e6

        is_incoming = to_addr == wallet_lc
        is_outgoing = from_addr == wallet_lc
        counterparty = from_addr if is_incoming else to_addr

        if _is_internal(counterparty):
            skipped_internal += 1
            continue

        # One row per tx, even if multiple transfers — sum the external component
        entry = by_tx.setdefault(tx_hash, {
            "tx_hash": tx_hash,
            "block_number": block_number,
            "net": 0.0,
            "token": token_label,
            "counterparty": counterparty,
        })
        if is_incoming:
            entry["net"] += value_usd
        elif is_outgoing:
            entry["net"] -= value_usd

    # Record rows
    for tx_hash, entry in by_tx.items():
        net = round(entry["net"], 6)
        if net == 0:
            continue  # pure self-transfer or cancelled flow
        direction = "deposit" if net > 0 else "withdrawal"
        amount = abs(net)

        # Skip dust (sometimes phishing-token contracts send $0.000001 to random wallets)
        if amount < 0.01:
            continue

        existing = conn.execute(
            "SELECT id FROM wallet_transactions WHERE tx_hash = ?", (tx_hash,)
        ).fetchone()
        if existing:
            continue  # already recorded in a prior sync

        # Fetch block timestamp via RPC for the ts field
        def _get_block_ts(w3, bn=entry["block_number"]):
            return int(w3.eth.get_block(bn)["timestamp"])
        try:
            block_ts = _call_with_rpc_fallback(_get_block_ts, label=f"block {entry['block_number']} ts")
            ts = datetime.fromtimestamp(block_ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        counterparty_label = _label_counterparty(entry["counterparty"])

        # Write ledger entry atomically with wallet_transactions row
        try:
            conn.execute("BEGIN IMMEDIATE")
            ledger_amount = amount if direction == "deposit" else -amount
            description = f"{'Deposit' if direction == 'deposit' else 'Withdrawal'}: ${amount:.2f} {entry['token']} ({counterparty_label[:40]})"
            cur = conn.execute(
                "INSERT INTO ledger (entry_type, amount, description, balance_after) "
                "VALUES (?, ?, ?, "
                "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) + ?, 6))",
                (direction, ledger_amount, description, ledger_amount),
            )
            ledger_id = cur.lastrowid

            conn.execute(
                "INSERT INTO wallet_transactions "
                "(tx_hash, block_number, ts, direction, amount_usd, token, counterparty, notes, ledger_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (tx_hash, entry["block_number"], ts, direction, amount,
                 entry["token"], counterparty_label, None, ledger_id),
            )
            conn.execute(
                "INSERT INTO events (event, detail) VALUES (?, ?)",
                (direction, f"${amount:.2f} {entry['token']} {'from' if direction=='deposit' else 'to'} {counterparty_label[:40]}"),
            )
            conn.commit()
        except Exception as e:
            conn.rollback()
            log.error(f"Failed to record wallet tx {tx_hash[:10]}: {e}")
            continue

        if direction == "deposit":
            deposits += 1
            log.info(f"Wallet sync: deposit ${amount:.2f} {entry['token']} from {counterparty_label[:40]} ({tx_hash[:10]})")
        else:
            withdrawals += 1
            log.info(f"Wallet sync: withdrawal ${amount:.2f} {entry['token']} to {counterparty_label[:40]} ({tx_hash[:10]})")

    set_meta(conn, "wallet_tx_last_scanned_block", str(to_block))
    conn.commit()

    return {
        "deposits": deposits,
        "withdrawals": withdrawals,
        "skipped_internal": skipped_internal,
        "scanned_from": from_block,
        "scanned_to": to_block,
    }


def reset_and_seed(conn, seed_amount: float | None = None) -> float:
    """Accounting hard reset: wipe transactional tables, re-seed from current on-chain balance.

    Preserves schema + meta (schema_version, alive, paused). Backs up nothing —
    caller is responsible for backing up vault.db before invoking.

    If `seed_amount` is None, queries on-chain USDC.e balance and uses that.
    Writes:
        - Fresh `go_live_reset` ledger entry anchored at the seed amount
        - A wallet_transactions 'deposit' entry labelled as the initial seed
        - `events` entry documenting the reset

    Returns the seeded balance.
    """
    from vault.clob_client import get_usdc_balance

    if seed_amount is None:
        seed_amount = get_usdc_balance()
        if seed_amount is None:
            raise RuntimeError("Cannot seed: on-chain USDC balance unavailable (RPC down)")

    # Tables to wipe completely (transactional / historical). Meta is kept.
    tables_to_wipe = [
        "ledger", "cycles", "events", "predictions", "positions", "trades",
        "api_calls", "pipeline_runs", "x_posts", "musk_markets",
        "odds_snapshots", "estimates", "edge_calculations", "calibration",
        "digests", "master_intelligence", "opus_estimates", "sentinel_alerts",
        "smart_money_log", "memory", "market_cache", "objectives",
        "wallet_transactions", "shadow_trades", "backtest_results",
    ]
    # Selective meta keys to clear (keep schema_version + alive)
    meta_keys_to_clear = [
        "paused", "dry_run_remaining", "peak_total_value",
        "rpc_failures_consecutive", "wallet_tx_last_scanned_block",
        "last_go_live_at",
    ]

    # Foreign keys reference cycles/predictions/etc; disable them during wipe
    # so the order of deletes doesn't matter. PRAGMA must be set outside a tx.
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("BEGIN IMMEDIATE")
        for tbl in tables_to_wipe:
            try:
                conn.execute(f"DELETE FROM {tbl}")
            except Exception as e:
                # Some tables may not exist in this schema version — that's fine.
                # Anything else we want to see loudly, not swallow.
                if "no such table" not in str(e).lower():
                    log.warning(f"Reset: DELETE FROM {tbl} failed: {e}")
        # Reset autoincrement counters so IDs start from 1 again
        try:
            conn.execute("DELETE FROM sqlite_sequence")
        except Exception as e:
            log.warning(f"Reset: DELETE FROM sqlite_sequence failed: {e}")
        for k in meta_keys_to_clear:
            conn.execute("DELETE FROM meta WHERE key = ?", (k,))
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('alive', 'true') "
            "ON CONFLICT(key) DO UPDATE SET value = 'true'"
        )
        conn.commit()
    except Exception:
        conn.rollback()
        conn.execute("PRAGMA foreign_keys = ON")
        raise
    conn.execute("PRAGMA foreign_keys = ON")

    # Seed the fresh ledger:
    # 1. Initial deposit of seed_amount (the initial on-chain balance)
    # 2. go_live_reset anchored at seed_amount (so real-mode gates still work)
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    conn.execute("BEGIN IMMEDIATE")
    try:
        # Seed as a deposit, not a 'seed' type — user asked for it to be the first deposit entry
        cur = conn.execute(
            "INSERT INTO ledger (entry_type, amount, description, balance_after) "
            "VALUES (?, ?, ?, ?)",
            ("deposit", seed_amount,
             f"Initial deposit (accounting reset): ${seed_amount:.2f}", seed_amount),
        )
        initial_ledger_id = cur.lastrowid

        # go_live anchor at same balance (real-mode gates require this)
        conn.execute(
            "INSERT INTO ledger (entry_type, amount, description, balance_after) "
            "VALUES (?, ?, ?, ?)",
            ("go_live_reset", 0.0,
             f"Go-live anchor after accounting reset: ${seed_amount:.2f}", seed_amount),
        )

        # Synthetic wallet_transactions row for the initial seed so it shows in cashflow UI
        conn.execute(
            "INSERT INTO wallet_transactions "
            "(tx_hash, block_number, ts, direction, amount_usd, token, counterparty, notes, ledger_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (f"reset-seed-{int(datetime.now(timezone.utc).timestamp())}", 0, now_iso,
             "deposit", seed_amount, "USDC.e", "Initial seed",
             "Initial deposit marker from accounting reset — represents consolidated on-chain balance at reset time",
             initial_ledger_id),
        )

        conn.execute(
            "INSERT INTO events (event, detail) VALUES (?, ?)",
            ("accounting_reset",
             f"Hard reset: all history cleared, seeded with ${seed_amount:.2f} as first deposit"),
        )
        conn.execute(
            "INSERT INTO events (event, detail) VALUES (?, ?)",
            ("go_live", f"Real mode re-anchored. On-chain USDC snapshot: ${seed_amount:.2f}"),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    # Initialise wallet sync high-water mark to current block so future
    # transfers are picked up without re-scanning history.
    try:
        from vault.clob_client import _call_with_rpc_fallback
        def _get_block(w3):
            return int(w3.eth.block_number)
        current_block = _call_with_rpc_fallback(_get_block, label="post-reset block")
        set_meta(conn, "wallet_tx_last_scanned_block", str(current_block))
        conn.commit()
    except Exception as e:
        log.warning(f"Could not initialise wallet sync high-water mark post-reset: {e}")

    log.info(f"Accounting reset complete. Seed deposit: ${seed_amount:.2f}")
    return seed_amount
