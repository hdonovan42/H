"""Status, daily, and full report generation — survival-focused."""

from datetime import datetime, timezone
from vault import ledger
from vault.guardrails import is_alive
from vault.cost_tracker import format_cost
from vault.daemon import read_pid


def status_report(conn) -> str:
    """Quick status report."""
    balance = ledger.get_balance(conn)
    burn_rate = ledger.get_burn_rate(conn)
    runway = ledger.get_runway(conn)
    total_api = ledger.get_total_api_costs(conn)
    total_pnl = ledger.get_total_pnl(conn)
    positions = ledger.get_open_positions(conn)
    alive = is_alive(conn)
    pid = read_pid()

    cycle_count = conn.execute("SELECT COUNT(*) as c FROM cycles").fetchone()["c"]

    # Alive duration
    first_event = conn.execute(
        "SELECT ts FROM events WHERE event IN ('start', 'resurrect') ORDER BY ts ASC LIMIT 1"
    ).fetchone()
    if first_event:
        started = datetime.fromisoformat(first_event["ts"].replace("Z", "+00:00"))
        alive_days = (datetime.now(timezone.utc) - started).total_seconds() / 86400
    else:
        alive_days = 0

    status = "ALIVE" if alive else "DEAD"
    daemon = f"running (PID {pid})" if pid else "stopped"

    lines = [
        f"╔══════════════════════════════════════╗",
        f"║          V A U L T  STATUS           ║",
        f"╠══════════════════════════════════════╣",
        f"║  Status:     {status:<24}║",
        f"║  Daemon:     {daemon:<24}║",
        f"║  Balance:    {format_cost(balance):<24}║",
        f"║  Burn rate:  {(format_cost(burn_rate) + '/day') if burn_rate else 'N/A':<24}║",
        f"║  Runway:     {(f'{runway:.1f} days') if runway else 'N/A':<24}║",
        f"║  Alive:      {f'{alive_days:.1f} days':<24}║",
        f"║  Cycles:     {cycle_count:<24}║",
        f"║  API costs:  {format_cost(total_api):<24}║",
        f"║  Trading P&L:{f' ${total_pnl:+.2f}':<24}║",
        f"╚══════════════════════════════════════╝",
    ]

    if positions:
        lines.append("\nOpen Positions:")
        for p in positions:
            lines.append(f"  [{p['id']}] {p['quantity']:.8f} {p['asset']} | cost: ${p['cost_basis']:.2f}")

    predictions = ledger.get_open_predictions(conn)
    if predictions:
        lines.append("\nOpen Predictions:")
        for p in predictions:
            lines.append(
                f"  [{p['id']}] {p['side']} '{p['question'][:50]}' | "
                f"{p['shares']:.2f} shares @ {p['entry_odds']:.0%} | cost: ${p['cost_basis']:.2f}"
            )

    return "\n".join(lines)


def full_report(conn) -> str:
    """Full P&L report with cost breakdown."""
    balance = ledger.get_balance(conn)
    burn_rate = ledger.get_burn_rate(conn)
    runway = ledger.get_runway(conn)
    total_api = ledger.get_total_api_costs(conn)
    total_pnl = ledger.get_total_pnl(conn)

    lines = [status_report(conn), ""]

    # Cost breakdown by model
    lines.append("API Cost Breakdown by Model:")
    rows = conn.execute(
        "SELECT model, COUNT(*) as calls, SUM(cost_usd) as total, "
        "SUM(input_tokens) as inp, SUM(output_tokens) as outp "
        "FROM api_calls GROUP BY model ORDER BY total DESC"
    ).fetchall()
    for r in rows:
        lines.append(
            f"  {r['model']}: {r['calls']} calls, ${r['total']:.4f} "
            f"({r['inp']} in / {r['outp']} out)"
        )

    # Closed positions
    closed = ledger.get_closed_positions(conn)
    if closed:
        lines.append(f"\nClosed Positions ({len(closed)}):")
        for p in closed:
            lines.append(
                f"  {p['asset']}: {p['quantity']:.8f} | "
                f"bought ${p['cost_basis']:.2f} → sold ${p['close_price'] * p['quantity']:.2f} | "
                f"P&L: ${p['pnl']:+.2f}"
            )

    # Closed predictions
    closed_preds = ledger.get_closed_predictions(conn)
    if closed_preds:
        lines.append(f"\nClosed Predictions ({len(closed_preds)}):")
        for p in closed_preds:
            lines.append(
                f"  {p['side']} '{p['question'][:50]}' | "
                f"cost ${p['cost_basis']:.2f} → payout ${p['payout']:.2f} | "
                f"{p['resolution'].upper()} | P&L: ${p['pnl']:+.2f}"
            )

    # Balance trajectory
    lines.append("\nBalance Trajectory (last 20 snapshots):")
    snapshots = conn.execute(
        "SELECT ts, balance, burn_rate, runway_days FROM objectives ORDER BY ts DESC LIMIT 20"
    ).fetchall()
    for s in reversed(list(snapshots)):
        lines.append(f"  {s['ts'][:16]} | ${s['balance']:.2f} | burn: {format_cost(s['burn_rate']) if s['burn_rate'] else 'N/A'}/day")

    # Recent events
    lines.append("\nRecent Events:")
    events = conn.execute(
        "SELECT ts, event, detail FROM events ORDER BY ts DESC LIMIT 10"
    ).fetchall()
    for e in reversed(list(events)):
        lines.append(f"  {e['ts'][:16]} | {e['event'].upper()}: {e['detail'][:80]}")

    return "\n".join(lines)


def logs_report(conn, limit: int = 20) -> str:
    """Recent cycle logs with reasoning."""
    rows = conn.execute(
        "SELECT id, ts_start, action, reasoning, total_cost, rounds_used, balance_after "
        "FROM cycles ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()

    if not rows:
        return "No cycles recorded yet."

    lines = ["Recent Cycles:"]
    for r in reversed(list(rows)):
        reasoning = (r["reasoning"] or "")[:100]
        lines.append(
            f"  [{r['id']}] {r['ts_start'][:16]} | {r['action'] or 'pending'} | "
            f"${r['total_cost']:.4f} ({r['rounds_used']}r) | "
            f"bal: ${r['balance_after']:.2f}" if r['balance_after'] is not None else "bal: $?"
        )
        if reasoning:
            lines.append(f"       └─ {reasoning}")

    return "\n".join(lines)
