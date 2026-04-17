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


def check_drawdown(conn) -> tuple[bool, str]:
    """Check if portfolio drawdown from peak exceeds circuit-breaker threshold.

    Returns (triggered, detail_string). Zero API cost — uses cached odds in DB.
    """
    cfg = load_config()
    cb_cfg = cfg.get("drawdown_circuit_breaker", {})
    if not cb_cfg.get("enabled", False):
        return False, ""

    max_dd = cb_cfg.get("max_drawdown_pct", 0.25)

    # Compute total value = cash + MTM open predictions
    balance = ledger.get_balance(conn)
    from vault.polymarket import get_current_odds
    positions_value = 0.0
    for pred in ledger.get_open_predictions(conn):
        odds = get_current_odds(conn, pred["market_id"])
        if odds:
            cp = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
            positions_value += pred["shares"] * cp
        else:
            positions_value += pred["cost_basis"]
    total_value = round(balance + positions_value, 6)

    # Read/update peak
    peak_str = get_meta(conn, "peak_total_value")
    if peak_str is None:
        # First run after migration — seed peak as current value
        set_meta(conn, "peak_total_value", str(total_value))
        return False, ""

    peak = float(peak_str)

    # New high — update peak and carry on
    if total_value > peak:
        set_meta(conn, "peak_total_value", str(round(total_value, 6)))
        return False, ""

    # Check drawdown
    if peak <= 0:
        return False, ""
    drawdown = (peak - total_value) / peak

    if drawdown >= max_dd:
        detail = (
            f"Circuit breaker triggered: drawdown {drawdown:.1%} "
            f"(peak ${peak:.2f} -> current ${total_value:.2f}, "
            f"threshold {max_dd:.0%}). VAULT auto-paused."
        )
        set_meta(conn, "paused", "true")
        conn.execute(
            "INSERT INTO events (event, detail) VALUES (?, ?)",
            ("circuit_breaker", detail),
        )
        conn.commit()
        log.warning(detail)
        return True, detail

    return False, ""


def check_balance_divergence(conn, tolerance: float = 1.0,
                             rpc_failure_threshold: int = 3) -> tuple[bool, str]:
    """Compare internal ledger to on-chain USDC. Auto-pauses on divergence OR repeated RPC failure.

    15 March 2026 incident: the old version returned (False, "RPC unavailable") on None,
    letting the daemon trade blind for hours while the wallet was actually empty. Now:
    consecutive RPC failures are counted in meta, and after `rpc_failure_threshold`
    the daemon is paused — a daemon that cannot verify on-chain state must not trade.

    Returns (diverged, detail).
    """
    from vault.clob_client import get_usdc_balance

    onchain = get_usdc_balance()
    if onchain is None:
        fails_str = get_meta(conn, "rpc_failures_consecutive") or "0"
        try:
            fails = int(fails_str)
        except ValueError:
            fails = 0
        fails += 1
        set_meta(conn, "rpc_failures_consecutive", str(fails))
        if fails >= rpc_failure_threshold:
            detail = (
                f"RPC unavailable for {fails} consecutive checks (threshold {rpc_failure_threshold}). "
                f"Cannot verify on-chain state — auto-pausing. Check Polygon RPC providers."
            )
            set_meta(conn, "paused", "true")
            conn.execute(
                "INSERT INTO events (event, detail) VALUES (?, ?)",
                ("rpc_unavailable_pause", detail),
            )
            conn.commit()
            log.critical(detail)
            return True, detail
        return False, f"RPC unavailable (fail {fails}/{rpc_failure_threshold})"

    # Reset failure counter on any successful RPC read
    set_meta(conn, "rpc_failures_consecutive", "0")

    expected = ledger.compute_expected_onchain(conn)
    drift = round(onchain - expected, 6)

    if drift < -tolerance:
        # Negative drift = money missing from wallet. Pause immediately.
        detail = (
            f"Balance divergence: on-chain ${onchain:.2f} vs expected ${expected:.2f} "
            f"(drift ${drift:+.2f}, tolerance ${tolerance:.2f}). Auto-pausing."
        )
        set_meta(conn, "paused", "true")
        conn.execute(
            "INSERT INTO events (event, detail) VALUES (?, ?)",
            ("balance_divergence", detail),
        )
        conn.commit()
        log.critical(detail)
        return True, detail

    if drift > tolerance:
        # Positive drift = deposit detected. Log but don't pause.
        log.info(f"Positive balance drift: ${drift:+.2f} (likely deposit, will be reconciled)")

    return False, f"OK (drift ${drift:+.2f})"


def resurrect(conn, seed_amount: float | None = None):
    """Resurrect VAULT — reset balance, close phantom positions, start fresh."""
    cfg = load_config()
    if seed_amount is None:
        seed_amount = cfg["seed_balance"]

    set_meta(conn, "alive", "true")
    set_meta(conn, "peak_total_value", str(seed_amount))

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
