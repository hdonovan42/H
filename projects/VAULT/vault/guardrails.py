"""Hard constraints and death condition."""

import logging
from vault.config_loader import load_config
from vault import ledger
from vault.db import get_meta, set_meta

log = logging.getLogger("vault.guardrails")


def check_death(conn) -> bool:
    """Check if VAULT is dead (balance <= 0). If so, log death and return True."""
    balance = ledger.get_balance(conn)
    if balance <= 0:
        alive = get_meta(conn, "alive")
        if alive == "true":
            # First time hitting death
            set_meta(conn, "alive", "false")
            conn.execute(
                "INSERT INTO events (event, detail) VALUES (?, ?)",
                ("death", f"Balance reached ${balance:.4f}. VAULT is dead."),
            )
            conn.commit()
            log.critical(f"DEATH: Balance ${balance:.4f} <= $0. VAULT is dead.")
        return True
    return False


def is_alive(conn) -> bool:
    """Check if VAULT is currently alive."""
    return get_meta(conn, "alive") == "true"


def check_trade_allowed(conn, amount_usd: float, asset: str) -> tuple[bool, str]:
    """Check if a trade passes guardrails. Returns (allowed, reason)."""
    balance = ledger.get_balance(conn)

    # Can't spend more than balance
    if amount_usd > balance:
        return False, f"Amount ${amount_usd:.2f} exceeds balance ${balance:.2f}"

    # Must have positive balance after trade
    if balance - amount_usd <= 0:
        return False, "Trade would reduce balance to $0 or below (death)"

    return True, "OK"


def check_cycle_cost(conn, cycle_id: int) -> bool:
    """Check if cycle has exceeded max cost. Returns True if over budget."""
    cfg = load_config()
    balance = ledger.get_balance(conn)
    max_cost = balance * cfg["agent"].get("max_cycle_cost_pct", 0.006)

    row = conn.execute(
        "SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_calls WHERE cycle_id = ?",
        (cycle_id,),
    ).fetchone()

    if row["total"] >= max_cost:
        log.warning(f"Cycle {cycle_id} exceeded max cost: ${row['total']:.4f} >= ${max_cost:.2f}")
        return True
    return False


def resurrect(conn, seed_amount: float | None = None):
    """Resurrect VAULT — reset balance, close phantom positions, start fresh."""
    cfg = load_config()
    if seed_amount is None:
        seed_amount = cfg["seed_balance"]

    set_meta(conn, "alive", "true")

    # Close all open predictions/positions from previous life to prevent phantom P&L
    open_count = conn.execute(
        "SELECT COUNT(*) as c FROM predictions WHERE status = 'open'"
    ).fetchone()["c"]
    if open_count > 0:
        conn.execute(
            "UPDATE predictions SET status = 'closed', resolution = 'abandoned', "
            "payout = 0, pnl = -cost_basis, "
            "closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE status = 'open'"
        )
        log.info(f"Closed {open_count} phantom predictions from previous life")

    open_pos_count = conn.execute(
        "SELECT COUNT(*) as c FROM positions WHERE status = 'open'"
    ).fetchone()["c"]
    if open_pos_count > 0:
        conn.execute(
            "UPDATE positions SET status = 'closed', pnl = -cost_basis, "
            "closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE status = 'open'"
        )
        log.info(f"Closed {open_pos_count} phantom positions from previous life")

    # Seed new balance
    conn.execute(
        "INSERT INTO ledger (entry_type, amount, description, balance_after) "
        "VALUES (?, ?, ?, ?)",
        ("seed", seed_amount, f"Resurrection: ${seed_amount:.2f}", seed_amount),
    )
    conn.execute(
        "INSERT INTO events (event, detail) VALUES (?, ?)",
        ("resurrect", f"Resurrected with ${seed_amount:.2f}"),
    )
    conn.commit()
    log.info(f"VAULT resurrected with ${seed_amount:.2f}")
