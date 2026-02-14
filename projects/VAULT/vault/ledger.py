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
    balance = get_balance(conn)
    new_balance = round(balance - cost, 6)

    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES (?, ?, ?, ?)",
        ("api_cost", -cost, description, new_balance),
    )
    conn.commit()

    log.debug(f"API cost: -${cost:.4f} | Balance: ${new_balance:.2f}")
    return new_balance


def record_trade_buy(conn, asset: str, quantity: float, price: float, total_usd: float, cycle_id: int | None = None) -> int:
    """Record a buy trade. Deducts from balance. Returns position_id."""
    balance = get_balance(conn)
    new_balance = round(balance - total_usd, 6)

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

    # Ledger entry
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, ?)",
        ("trade_buy", -total_usd, f"BUY {quantity:.8f} {asset} @ ${price:,.2f}", position_id, new_balance),
    )
    conn.commit()

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

    balance = get_balance(conn)
    new_balance = round(balance + total_usd, 6)

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

    # Ledger entry
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, ?)",
        ("trade_sell", total_usd, f"SELL {quantity:.8f} {asset} @ ${price:,.2f} (P&L: ${pnl:+.2f})", position_id, new_balance),
    )
    conn.commit()

    log.info(f"SELL {quantity:.8f} {asset} @ ${price:,.2f} = ${total_usd:.2f} | P&L: ${pnl:+.2f} | Balance: ${new_balance:.2f}")
    return pnl


def record_prediction_buy(conn, market_id: str, condition_id: str | None,
                          question: str, slug: str | None, side: str,
                          amount_usd: float, odds: float,
                          clob_token_id: str | None = None,
                          end_date: str | None = None,
                          cycle_id: int | None = None,
                          entry_edge: float | None = None,
                          entry_reasoning: str | None = None) -> int:
    """Place a prediction bet. Deducts from balance. Returns prediction_id."""
    balance = get_balance(conn)
    new_balance = round(balance - amount_usd, 6)

    # shares = amount / odds (e.g. $5 at 0.60 odds = 8.33 shares, paying out $8.33 if won)
    shares = round(amount_usd / odds, 6)

    cur = conn.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, shares, "
        "entry_odds, cost_basis, clob_token_id, end_date, entry_edge, entry_reasoning) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (market_id, condition_id, question, slug, side, shares,
         odds, amount_usd, clob_token_id, end_date, entry_edge, entry_reasoning),
    )
    prediction_id = cur.lastrowid

    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, ?)",
        ("prediction_buy", -amount_usd,
         f"BET {side} '{question[:60]}' @ {odds:.0%} (${amount_usd:.2f})",
         prediction_id, new_balance),
    )
    conn.commit()

    log.info(f"BET {side} '{question[:40]}' @ {odds:.0%} | ${amount_usd:.2f} for {shares:.2f} shares | Balance: ${new_balance:.2f}")
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

    balance = get_balance(conn)
    new_balance = round(balance + payout, 6)

    conn.execute(
        "UPDATE predictions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
        "resolution = ?, payout = ?, pnl = ?, status = 'closed' WHERE id = ?",
        (resolution, payout, pnl, prediction_id),
    )

    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, ?)",
        ("prediction_resolve", payout,
         f"RESOLVED {resolution.upper()} '{pred['question'][:50]}' (P&L: ${pnl:+.2f})",
         prediction_id, new_balance),
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

    balance = get_balance(conn)
    new_balance = round(balance + sell_value, 6)

    conn.execute(
        "UPDATE predictions SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
        "resolution = 'sold', payout = ?, pnl = ?, status = 'closed' WHERE id = ?",
        (sell_value, pnl, prediction_id),
    )

    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, reference_id, balance_after) "
        "VALUES (?, ?, ?, ?, ?)",
        ("prediction_sell", sell_value,
         f"SELL prediction '{pred['question'][:50]}' @ {current_odds:.0%} (P&L: ${pnl:+.2f})",
         prediction_id, new_balance),
    )
    conn.commit()

    log.info(f"SOLD prediction {prediction_id} @ {current_odds:.0%} = ${sell_value:.2f} | P&L: ${pnl:+.2f}")
    return pnl


def get_open_predictions(conn) -> list[dict]:
    """Get all open predictions."""
    rows = conn.execute(
        "SELECT id, market_id, question, slug, side, shares, entry_odds, "
        "cost_basis, end_date, opened_at, entry_edge, entry_reasoning "
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
    """Average daily API cost burn rate. None if < 1 day of data."""
    rows = conn.execute(
        "SELECT MIN(ts) as first_ts, MAX(ts) as last_ts, SUM(cost_usd) as total "
        "FROM api_calls"
    ).fetchone()

    if not rows or not rows["first_ts"] or rows["total"] == 0:
        return None

    from datetime import datetime, timezone
    first = datetime.fromisoformat(rows["first_ts"].replace("Z", "+00:00"))
    last = datetime.fromisoformat(rows["last_ts"].replace("Z", "+00:00"))
    days = max((last - first).total_seconds() / 86400, 0.01)  # At least ~15 min

    return round(rows["total"] / days, 4)


def get_runway(conn) -> float | None:
    """Estimated days until death at current burn rate."""
    burn = get_burn_rate(conn)
    if burn is None or burn <= 0:
        return None
    balance = get_balance(conn)
    return round(balance / burn, 1)
