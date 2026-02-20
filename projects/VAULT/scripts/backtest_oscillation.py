#!/usr/bin/env python3
"""Backtest the oscillation detector against historical VAULT trades.

Connects read-only to vault.db, computes reversals_2h and net_move_2h at the
time of first entry for every historically traded market, and reports:
- Which markets would have been flagged
- Expected P&L difference (savings from dampening)
"""

import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "vault.db"

# Detector params (match config/default.yaml)
OSC_LOOKBACK_HOURS = 2.0
OSC_MIN_SWING = 0.08
OSC_MAX_REVERSALS = 6
OSC_NET_MOVE_OVERRIDE = 0.15


def parse_ts(ts_str):
    return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))


def compute_oscillation(conn, market_id, at_time):
    """Compute reversals_2h and net_move_2h for a market at a given timestamp."""
    cutoff = (at_time - timedelta(hours=OSC_LOOKBACK_HOURS)).strftime("%Y-%m-%dT%H:%M:%S")
    at_str = at_time.strftime("%Y-%m-%dT%H:%M:%S")

    rows = conn.execute(
        "SELECT yes_price, ts FROM odds_snapshots "
        "WHERE market_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
        (market_id, cutoff, at_str),
    ).fetchall()

    if len(rows) < 3:
        return 0, 0.0, len(rows)

    prices = [r["yes_price"] for r in rows]
    net_move = round(prices[-1] - prices[0], 4)

    reversals = 0
    direction = None
    last_extreme = prices[0]
    for p in prices[1:]:
        move = p - last_extreme
        if abs(move) < OSC_MIN_SWING:
            continue
        new_dir = "up" if move > 0 else "down"
        if direction is not None and new_dir != direction:
            reversals += 1
        direction = new_dir
        last_extreme = p

    return reversals, net_move, len(rows)


def is_oscillating(reversals, net_move):
    return reversals >= OSC_MAX_REVERSALS and abs(net_move) < OSC_NET_MOVE_OVERRIDE


def main():
    if not DB_PATH.exists():
        print(f"Database not found: {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    # Get all markets with trades (predictions)
    markets = conn.execute("""
        SELECT DISTINCT p.market_id, p.question,
               MIN(p.opened_at) as first_entry,
               SUM(CASE WHEN p.pnl IS NOT NULL THEN p.pnl ELSE 0 END) as total_pnl,
               COUNT(*) as trade_count,
               SUM(p.cost_basis) as total_cost
        FROM predictions p
        WHERE p.opened_at IS NOT NULL
        GROUP BY p.market_id
        ORDER BY total_pnl ASC
    """).fetchall()

    print(f"{'Market':<55} {'Rev':>4} {'Net':>7} {'Flag':>5} {'PnL':>8} {'Trades':>6}")
    print("-" * 95)

    flagged_savings = 0.0
    flagged_markets = []
    clean_markets = []

    for m in markets:
        first_entry = parse_ts(m["first_entry"])
        reversals, net_move, snap_count = compute_oscillation(conn, m["market_id"], first_entry)
        flagged = is_oscillating(reversals, net_move)
        q = (m["question"] or m["market_id"])[:54]
        flag_str = "YES" if flagged else ""

        print(
            f"{q:<55} {reversals:>4} {net_move:>+6.0%} {flag_str:>5} "
            f"${m['total_pnl']:>+7.2f} {m['trade_count']:>6}"
        )

        if flagged:
            flagged_savings += abs(min(m["total_pnl"], 0))  # savings = avoided losses
            flagged_markets.append((q, reversals, net_move, m["total_pnl"], m["trade_count"]))
        else:
            clean_markets.append((q, reversals, net_move, m["total_pnl"], m["trade_count"]))

    print("-" * 95)
    print(f"\nFlagged markets ({len(flagged_markets)}):")
    for q, rev, net, pnl, trades in flagged_markets:
        print(f"  {q} — {rev} reversals, net {net:+.0%}, PnL ${pnl:+.2f} ({trades} trades)")

    print(f"\nClean markets ({len(clean_markets)}):")
    for q, rev, net, pnl, trades in clean_markets:
        print(f"  {q} — {rev} reversals, net {net:+.0%}, PnL ${pnl:+.2f} ({trades} trades)")

    # Calculate savings: for flagged markets, dampener would have limited to 1 position
    # Approximate: if market had N trades and lost $X, with 1-position cap we'd lose ~$X/N
    estimated_savings = 0.0
    for q, rev, net, pnl, trades in flagged_markets:
        if pnl < 0 and trades > 1:
            # With dampener: only 1 position, so loss ≈ pnl / trades
            dampened_loss = pnl / trades
            saved = abs(pnl) - abs(dampened_loss)
            estimated_savings += saved
            print(f"\n  Savings estimate for {q}:")
            print(f"    Actual loss: ${pnl:.2f} across {trades} trades")
            print(f"    Dampened loss (1 position): ~${dampened_loss:.2f}")
            print(f"    Estimated savings: ~${saved:.2f}")

    print(f"\n{'='*60}")
    print(f"Total flagged market losses avoided (full block): ${flagged_savings:.2f}")
    print(f"Total estimated savings (1-position cap): ~${estimated_savings:.2f}")
    print(f"False positives on winners: {sum(1 for _, _, _, pnl, _ in flagged_markets if pnl > 0)}")

    conn.close()


if __name__ == "__main__":
    main()
