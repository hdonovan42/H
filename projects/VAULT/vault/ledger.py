"""Unified balance — seed, API costs, and trading P&L all in one pool."""

import logging
from vault.config_loader import load_config

log = logging.getLogger("vault.ledger")


def get_balance(conn) -> float:
    """Get current balance from most recent ledger entry."""
    row = conn.execute(
        "SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return row["balance_after"] if row else 0.0


def seed_balance(conn, amount: float | None = None):
    """Seed initial balance. Only if ledger is empty."""
    existing = conn.execute("SELECT COUNT(*) as c FROM ledger").fetchone()["c"]
    if existing > 0:
        return  # Already seeded

    if amount is None:
        cfg = load_config()
        amount = cfg["seed_balance"]

    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES (?, ?, ?, ?)",
        ("seed", amount, f"Initial seed: ${amount:.2f}", amount),
    )
    conn.commit()
    log.info(f"Balance seeded: ${amount:.2f}")


def deduct_api_cost(conn, cost: float, description: str = "") -> float:
    """Deduct API cost from balance. Returns new balance."""
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES (?, ?, ?, "
        "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) - ?, 6))",
        ("api_cost", -cost, description, cost),
    )
    conn.commit()

    new_balance = get_balance(conn)
    log.debug(f"API cost: -${cost:.4f} | Balance: ${new_balance:.2f}")
    return new_balance


def record_trade_buy(conn, asset: str, quantity: float, price: float, total_usd: float, cycle_id: int | None = None) -> int:
    """Record a buy trade. Deducts from balance. Returns position_id."""
    # Create position
    cur = conn.execute(
        "INSERT INTO positions (asset, quantity, cost_basis, status) VALUES (?, ?, ?, 'open')",
        (asset, quantity, total_usd),
    )
    position_id = cur.lastrowid

    # Record trade
    conn.execute(
        "INSERT INTO trades (cycle_id, side, asset, quantity, price, total_usd, position_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (cycle_id, "buy", asset, quantity, price, total_usd, position_id),
    )

    # Ledger entry — atomic balance via SQL subquery
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, "
        "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) - ?, 6))",
        ("trade_buy", -total_usd, f"BUY {quantity:.8f} {asset} @ ${price:,.2f}", position_id, total_usd),
    )
    conn.commit()

    new_balance = get_balance(conn)
    log.info(f"BUY {quantity:.8f} {asset} @ ${price:,.2f} = ${total_usd:.2f} | Balance: ${new_balance:.2f}")
    return position_id


def record_trade_sell(conn, position_id: int, price: float, cycle_id: int | None = None) -> float:
    """Close a position at given price. Returns P&L."""
    pos = conn.execute(
        "SELECT * FROM positions WHERE id = ? AND status = 'open'", (position_id,)
    ).fetchone()

    if not pos:
        raise ValueError(f"No open position with id {position_id}")

    asset = pos["asset"]
    quantity = pos["quantity"]
    cost_basis = pos["cost_basis"]
    total_usd = round(quantity * price, 6)
    pnl = round(total_usd - cost_basis, 6)

    # Close position
    conn.execute(
        "UPDATE positions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
        "close_price = ?, pnl = ?, status = 'closed' WHERE id = ?",
        (price, pnl, position_id),
    )

    # Record trade
    conn.execute(
        "INSERT INTO trades (cycle_id, side, asset, quantity, price, total_usd, position_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (cycle_id, "sell", asset, quantity, price, total_usd, position_id),
    )

    # Ledger entry — atomic balance via SQL subquery
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, "
        "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) + ?, 6))",
        ("trade_sell", total_usd, f"SELL {quantity:.8f} {asset} @ ${price:,.2f} (P&L: ${pnl:+.2f})", position_id, total_usd),
    )
    conn.commit()

    new_balance = get_balance(conn)
    log.info(f"SELL {quantity:.8f} {asset} @ ${price:,.2f} = ${total_usd:.2f} | P&L: ${pnl:+.2f} | Balance: ${new_balance:.2f}")
    return pnl


def record_prediction_buy(conn, market_id: str, condition_id: str | None,
                          question: str, slug: str | None, side: str,
                          amount_usd: float, odds: float,
                          clob_token_id: str | None = None,
                          end_date: str | None = None,
                          cycle_id: int | None = None,
                          entry_edge: float | None = None,
                          entry_confidence: float | None = None,
                          entry_reasoning: str | None = None,
                          execution_mode: str = "paper",
                          shares_override: float | None = None) -> int:
    """Place a prediction bet. Deducts from balance. Returns prediction_id.

    If shares_override is set (from a real CLOB fill), use it instead of amount/odds.
    """
    shares = round(shares_override, 6) if shares_override is not None else round(amount_usd / odds, 6)

    cur = conn.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, shares, "
        "entry_odds, cost_basis, clob_token_id, end_date, entry_edge, entry_confidence, "
        "entry_reasoning, execution_mode) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (market_id, condition_id, question, slug, side, shares,
         odds, amount_usd, clob_token_id, end_date, entry_edge, entry_confidence,
         entry_reasoning, execution_mode),
    )
    prediction_id = cur.lastrowid

    # Ledger entry — atomic balance via SQL subquery
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, "
        "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) - ?, 6))",
        ("prediction_buy", -amount_usd,
         f"BET {side} '{question[:60]}' @ {odds:.0%} (${amount_usd:.2f})",
         prediction_id, amount_usd),
    )
    conn.commit()

    mode_tag = " [REAL]" if execution_mode == "real" else ""
    new_balance = get_balance(conn)
    log.info(f"BET{mode_tag} {side} '{question[:40]}' @ {odds:.0%} | ${amount_usd:.2f} for {shares:.2f} shares | Balance: ${new_balance:.2f}")
    return prediction_id


def record_prediction_resolve(conn, prediction_id: int, winner: str) -> float:
    """Resolve a prediction. Returns payout (0 if lost, $1/share if won)."""
    pred = conn.execute(
        "SELECT * FROM predictions WHERE id = ? AND status = 'open'",
        (prediction_id,),
    ).fetchone()

    if not pred:
        raise ValueError(f"No open prediction with id {prediction_id}")

    won = pred["side"] == winner
    payout = round(pred["shares"], 6) if won else 0.0
    pnl = round(payout - pred["cost_basis"], 6)
    resolution = "won" if won else "lost"

    conn.execute(
        "UPDATE predictions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
        "resolution = ?, payout = ?, pnl = ?, status = 'closed' WHERE id = ?",
        (resolution, payout, pnl, prediction_id),
    )

    # Ledger entry — atomic balance via SQL subquery
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, "
        "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) + ?, 6))",
        ("prediction_resolve", payout,
         f"RESOLVED {resolution.upper()} '{pred['question'][:50]}' (P&L: ${pnl:+.2f})",
         prediction_id, payout),
    )
    conn.commit()

    log.info(f"RESOLVED {resolution.upper()} prediction {prediction_id}: payout ${payout:.2f}, P&L ${pnl:+.2f}")
    return pnl


def record_prediction_sell(conn, prediction_id: int, current_odds: float,
                           cycle_id: int | None = None) -> float:
    """Exit a prediction early at current odds. Returns P&L."""
    pred = conn.execute(
        "SELECT * FROM predictions WHERE id = ? AND status = 'open'",
        (prediction_id,),
    ).fetchone()

    if not pred:
        raise ValueError(f"No open prediction with id {prediction_id}")

    # Sell value = shares * current_odds for that side
    sell_value = round(pred["shares"] * current_odds, 6)
    pnl = round(sell_value - pred["cost_basis"], 6)

    conn.execute(
        "UPDATE predictions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
        "resolution = 'sold', payout = ?, pnl = ?, status = 'closed' WHERE id = ?",
        (sell_value, pnl, prediction_id),
    )

    # Ledger entry — atomic balance via SQL subquery
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, "
        "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) + ?, 6))",
        ("prediction_sell", sell_value,
         f"SELL prediction '{pred['question'][:50]}' @ {current_odds:.0%} (P&L: ${pnl:+.2f})",
         prediction_id, sell_value),
    )
    conn.commit()

    log.info(f"SOLD prediction {prediction_id} @ {current_odds:.0%} = ${sell_value:.2f} | P&L: ${pnl:+.2f}")
    return pnl


def compute_expected_onchain(conn) -> float:
    """Compute expected on-chain USDC from DB state.

    Anchored on the most recent `go_live_reset` entry. Before go-live, returns 0
    (no real money expected to exist on-chain). After go-live:

        expected = anchor_balance
                 + deposits recorded after anchor
                 - cost_basis of all real predictions (pending/open/closed/reconciling)
                 + payouts from closed real predictions

    `cancelled` rows are excluded because they never actually moved USDC.
    """
    anchor_row = conn.execute(
        "SELECT id, balance_after FROM ledger "
        "WHERE entry_type = 'go_live_reset' ORDER BY id DESC LIMIT 1"
    ).fetchone()

    if anchor_row is None:
        # Never gone live → no on-chain money expected
        return 0.0

    anchor_id = anchor_row["id"]
    anchor_balance = anchor_row["balance_after"]

    # Deposit amounts are positive; withdrawal amounts are stored negative.
    # Summing both in one query yields the net external cashflow since anchor.
    deposits_after = conn.execute(
        "SELECT COALESCE(SUM(amount), 0) FROM ledger "
        "WHERE entry_type IN ('deposit', 'withdrawal') AND id > ?",
        (anchor_id,),
    ).fetchone()[0]
    real_costs = conn.execute(
        "SELECT COALESCE(SUM(cost_basis), 0) FROM predictions "
        "WHERE execution_mode = 'real' AND status IN ('pending', 'open', 'reconciling', 'closed')"
    ).fetchone()[0]
    real_payouts = conn.execute(
        "SELECT COALESCE(SUM(payout), 0) FROM predictions "
        "WHERE execution_mode = 'real' AND status = 'closed' AND payout IS NOT NULL"
    ).fetchone()[0]
    return round(anchor_balance + deposits_after - real_costs + real_payouts, 6)


def record_prediction_pending(conn, *, market_id: str, condition_id: str | None,
                              question: str, slug: str | None, side: str,
                              amount_usd: float, odds: float,
                              clob_token_id: str,
                              end_date: str | None = None,
                              cycle_id: int | None = None,
                              entry_edge: float | None = None,
                              entry_confidence: float | None = None,
                              entry_reasoning: str | None = None,
                              clob_attempt_id: str) -> int:
    """Record a real-mode bet as `pending` BEFORE placing the CLOB order.

    This is the first step of the two-phase commit introduced after the 15 March
    incident. The row is inserted with:
        status = 'pending', execution_mode = 'real', pending_since = now,
        cost_basis = amount_usd (the anticipated cost),
        shares = amount_usd / odds (the anticipated shares at mid).

    NO ledger entry is written here — USDC has not yet left the wallet. The
    ledger debit happens atomically in `record_prediction_confirm()` after the
    CLOB fill is verified on-chain.

    Returns the prediction_id — caller must pass it to confirm() or cancel().
    """
    shares = round(amount_usd / odds, 6) if odds > 0 else 0.0

    cur = conn.execute(
        "INSERT INTO predictions "
        "(market_id, condition_id, question, slug, side, shares, entry_odds, cost_basis, "
        " clob_token_id, end_date, entry_edge, entry_confidence, entry_reasoning, "
        " execution_mode, status, pending_since, clob_attempt_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'real', 'pending', "
        "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)",
        (market_id, condition_id, question, slug, side, shares, odds, amount_usd,
         clob_token_id, end_date, entry_edge, entry_confidence, entry_reasoning,
         clob_attempt_id),
    )
    conn.commit()
    prediction_id = cur.lastrowid
    log.info(
        f"BET PENDING [REAL] {side} '{question[:40]}' @ {odds:.0%} | ${amount_usd:.2f} "
        f"(pred #{prediction_id}, attempt {clob_attempt_id[:8]})"
    )
    return prediction_id


def record_prediction_confirm(conn, prediction_id: int, *, fill_amount_usd: float,
                              fill_shares: float, fill_odds: float,
                              fill_verified: bool = False) -> float:
    """Transition a pending real prediction to `open` and atomically debit the ledger.

    Single transaction: UPDATE prediction status + INSERT ledger entry. If either
    fails, both roll back. This is the fix for the class of bugs where CLOB
    filled but the DB never recorded it.

    Returns the new ledger balance. Raises ValueError if the prediction isn't pending.
    """
    pred = conn.execute(
        "SELECT id, question, side, status, execution_mode FROM predictions WHERE id = ?",
        (prediction_id,),
    ).fetchone()
    if pred is None:
        raise ValueError(f"Prediction {prediction_id} not found")
    if pred["status"] != "pending":
        raise ValueError(
            f"Prediction {prediction_id} has status '{pred['status']}', not 'pending' — "
            f"refusing to confirm (possible double-confirm or stale write)"
        )
    if pred["execution_mode"] != "real":
        raise ValueError(f"Prediction {prediction_id} is not real mode — use record_prediction_buy")

    verified_ts = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" if fill_verified else "NULL"
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            f"UPDATE predictions SET status = 'open', "
            f"shares = ?, entry_odds = ?, cost_basis = ?, "
            f"fill_verified_at = {verified_ts} "
            f"WHERE id = ?",
            (fill_shares, fill_odds, fill_amount_usd, prediction_id),
        )
        conn.execute(
            "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
            "VALUES (?, ?, ?, ?, "
            "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) - ?, 6))",
            ("prediction_buy", -fill_amount_usd,
             f"BET [REAL] {pred['side']} '{pred['question'][:60]}' @ {fill_odds:.0%} (${fill_amount_usd:.2f})",
             prediction_id, fill_amount_usd),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    new_balance = get_balance(conn)
    log.info(
        f"BET CONFIRMED [REAL] pred #{prediction_id} '{pred['question'][:40]}' "
        f"@ {fill_odds:.0%} | ${fill_amount_usd:.2f} for {fill_shares:.2f} shares | "
        f"Balance: ${new_balance:.2f}{' (on-chain verified)' if fill_verified else ''}"
    )
    return new_balance


def record_prediction_cancel(conn, prediction_id: int, reason: str) -> None:
    """Transition a pending prediction to `cancelled`. No ledger entry — USDC never moved."""
    pred = conn.execute(
        "SELECT id, question, status FROM predictions WHERE id = ?",
        (prediction_id,),
    ).fetchone()
    if pred is None:
        raise ValueError(f"Prediction {prediction_id} not found")
    if pred["status"] != "pending":
        raise ValueError(
            f"Prediction {prediction_id} has status '{pred['status']}' — "
            f"can only cancel pending rows"
        )

    conn.execute(
        "UPDATE predictions SET status = 'cancelled', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
        "resolution = 'cancelled', payout = 0, pnl = 0, "
        "entry_reasoning = COALESCE(entry_reasoning, '') || ' | CANCELLED: ' || ? "
        "WHERE id = ?",
        (reason, prediction_id),
    )
    conn.commit()
    log.info(f"BET CANCELLED pred #{prediction_id} '{pred['question'][:40]}': {reason}")


def record_prediction_reconciling(conn, prediction_id: int, reason: str) -> None:
    """Flag a pending prediction as needing reconciliation (orphan sweep will handle)."""
    conn.execute(
        "UPDATE predictions SET status = 'reconciling', "
        "entry_reasoning = COALESCE(entry_reasoning, '') || ' | RECONCILING: ' || ? "
        "WHERE id = ?",
        (reason, prediction_id),
    )
    conn.execute(
        "INSERT INTO events (event, detail) VALUES (?, ?)",
        ("reconciling", f"Pred #{prediction_id}: {reason}"),
    )
    conn.commit()
    log.critical(f"BET RECONCILING pred #{prediction_id}: {reason}")


def get_pending_predictions(conn) -> list[dict]:
    """Return all real-mode predictions stuck in 'pending' status."""
    rows = conn.execute(
        "SELECT id, market_id, question, side, shares, entry_odds, cost_basis, "
        "clob_token_id, pending_since, clob_attempt_id "
        "FROM predictions WHERE status = 'pending' AND execution_mode = 'real' "
        "ORDER BY pending_since ASC"
    ).fetchall()
    return [dict(r) for r in rows]


def has_pending_predictions(conn) -> bool:
    """True if any real-mode prediction is currently in 'pending' status."""
    row = conn.execute(
        "SELECT COUNT(*) FROM predictions WHERE status = 'pending' AND execution_mode = 'real'"
    ).fetchone()
    return int(row[0]) > 0


def go_live_reset(conn, onchain_usdc: float) -> float:
    """Transition VAULT to real-money mode.

    1. Asserts no open real predictions exist (would invalidate accounting).
    2. Writes a `go_live_reset` ledger entry that snaps the balance to the on-chain USDC amount.
       The `amount` is the delta needed to move from paper balance to on-chain reality.
    3. Writes a `go_live` event for audit trail.
    4. Initialises on-chain anchor meta keys.

    Returns new balance (== onchain_usdc). Raises RuntimeError on violation.
    """
    open_real = conn.execute(
        "SELECT COUNT(*) FROM predictions "
        "WHERE execution_mode = 'real' AND status IN ('pending', 'open', 'reconciling')"
    ).fetchone()[0]
    if open_real > 0:
        raise RuntimeError(
            f"Cannot go live: {open_real} open real predictions from a previous life. "
            f"Resolve or reconcile them first, or resurrect the DB."
        )

    current = get_balance(conn)
    delta = round(onchain_usdc - current, 6)

    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) VALUES (?, ?, ?, ?)",
        ("go_live_reset", delta,
         f"Go-live: paper ${current:.2f} -> on-chain ${onchain_usdc:.2f}",
         round(onchain_usdc, 6)),
    )
    conn.execute(
        "INSERT INTO events (event, detail) VALUES (?, ?)",
        ("go_live", f"Real mode enabled. On-chain USDC snapshot: ${onchain_usdc:.2f}"),
    )
    from vault.db import set_meta
    set_meta(conn, "last_go_live_at", "now")  # triggers db to use sqlite 'now'; stored as ISO by set_meta? Let's check.
    # Safer: use explicit timestamp string.
    import datetime as _dt
    set_meta(conn, "last_go_live_at", _dt.datetime.now(_dt.timezone.utc).isoformat())
    conn.commit()

    log.critical(
        f"GO LIVE: paper balance ${current:.2f} -> real balance ${onchain_usdc:.2f} "
        f"(delta ${delta:+.2f})"
    )
    return onchain_usdc


def is_live(conn) -> bool:
    """True if the ledger has ever been reset to real-money mode via go_live."""
    row = conn.execute(
        "SELECT 1 FROM ledger WHERE entry_type = 'go_live_reset' LIMIT 1"
    ).fetchone()
    return row is not None


def record_deposit(conn, amount: float) -> float:
    """Record an auto-detected on-chain deposit. Returns new balance."""
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES (?, ?, ?, "
        "ROUND((SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1) + ?, 6))",
        ("deposit", amount, f"Auto-detected on-chain deposit: ${amount:.2f}", amount),
    )
    conn.execute(
        "INSERT INTO events (event, detail) VALUES (?, ?)",
        ("deposit", f"Auto-detected on-chain deposit: ${amount:.2f}"),
    )
    conn.commit()

    new_balance = get_balance(conn)
    log.info(f"Deposit detected: ${amount:.2f} | New balance: ${new_balance:.2f}")
    return new_balance


def get_open_predictions(conn) -> list[dict]:
    """Get all open predictions."""
    rows = conn.execute(
        "SELECT id, market_id, question, slug, side, shares, entry_odds, "
        "cost_basis, end_date, opened_at, entry_edge, entry_confidence, entry_reasoning, "
        "peak_roi, execution_mode, clob_token_id "
        "FROM predictions WHERE status = 'open'"
    ).fetchall()
    return [dict(r) for r in rows]


def get_closed_predictions(conn) -> list[dict]:
    """Get all closed predictions."""
    rows = conn.execute(
        "SELECT * FROM predictions WHERE status = 'closed' ORDER BY closed_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_prediction_pnl(conn) -> float:
    """Total realized P&L from closed predictions."""
    row = conn.execute(
        "SELECT COALESCE(SUM(pnl), 0) as total FROM predictions WHERE status = 'closed'"
    ).fetchone()
    return row["total"]


def get_open_positions(conn) -> list[dict]:
    """Get all open positions."""
    rows = conn.execute(
        "SELECT id, asset, quantity, cost_basis, opened_at FROM positions WHERE status = 'open'"
    ).fetchall()
    return [dict(r) for r in rows]


def get_closed_positions(conn) -> list[dict]:
    """Get all closed positions."""
    rows = conn.execute(
        "SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_total_pnl(conn) -> float:
    """Total realized P&L from closed positions + predictions."""
    trade_pnl = conn.execute(
        "SELECT COALESCE(SUM(pnl), 0) as total FROM positions WHERE status = 'closed'"
    ).fetchone()["total"]
    pred_pnl = conn.execute(
        "SELECT COALESCE(SUM(pnl), 0) as total FROM predictions WHERE status = 'closed'"
    ).fetchone()["total"]
    return trade_pnl + pred_pnl


def get_total_api_costs(conn) -> float:
    """Total API costs spent."""
    row = conn.execute(
        "SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_calls"
    ).fetchone()
    return row["total"]


def get_burn_rate(conn) -> float | None:
    """Daily API cost burn rate based on last 24 hours of spend."""
    row = conn.execute(
        "SELECT COALESCE(SUM(cost_usd), 0) as total "
        "FROM api_calls "
        "WHERE ts >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')"
    ).fetchone()

    if not row or row["total"] == 0:
        return None

    return round(row["total"], 4)


def get_runway(conn) -> float | None:
    """Estimated days until death at current burn rate."""
    burn = get_burn_rate(conn)
    if burn is None or burn <= 0:
        return None
    balance = get_balance(conn)
    return round(balance / burn, 1)
