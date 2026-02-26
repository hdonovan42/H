#!/usr/bin/env python3
"""Analyze the cost of safeguards: winning bets that would have been blocked."""

import sqlite3
from datetime import datetime, timedelta
from collections import defaultdict

db = sqlite3.connect("vault.db")
db.row_factory = sqlite3.Row

# All closed Sharp move (momentum) predictions
all_momentum = db.execute("""
    SELECT p.id, p.market_id, p.question, p.side, p.cost_basis, p.pnl,
           p.opened_at, p.closed_at, p.entry_reasoning, p.shares, p.entry_odds
    FROM predictions p
    WHERE p.status = 'closed'
      AND p.entry_reasoning LIKE 'Sharp move%'
    ORDER BY p.market_id, p.opened_at
""").fetchall()
all_momentum = [dict(r) for r in all_momentum]

print("Total closed momentum predictions: {}".format(len(all_momentum)))
winners = [p for p in all_momentum if p["pnl"] > 0]
losers = [p for p in all_momentum if p["pnl"] <= 0]
print("Winners: {} (total PnL: ${:.2f})".format(len(winners), sum(p["pnl"] for p in winners)))
print("Losers: {} (total PnL: ${:.2f})".format(len(losers), sum(p["pnl"] for p in losers)))
print("Net: ${:.2f}".format(sum(p["pnl"] for p in all_momentum)))
print()

# Group by market
by_market = defaultdict(list)
for p in all_momentum:
    by_market[p["market_id"]].append(p)

# ============================================================
# 1. VOLUME GUARD (v16.17)
# Rule: Skip momentum bets on markets with volume < $10,000
# ============================================================
print("=" * 80)
print("1. VOLUME GUARD (v16.17)")
print("   Rule: Skip momentum bets on markets with volume < $10,000")
print("=" * 80)

vol_blocked_winners = []
vol_blocked_losers = []
vol_ids = set()
for p in all_momentum:
    mkt = db.execute(
        "SELECT volume FROM musk_markets WHERE market_id = ?", (p["market_id"],)
    ).fetchone()
    vol = mkt["volume"] if mkt and mkt["volume"] else 0
    if vol < 10000:
        if p["pnl"] > 0:
            vol_blocked_winners.append({**p, "volume": vol})
            vol_ids.add(p["id"])
        else:
            vol_blocked_losers.append({**p, "volume": vol})

if vol_blocked_winners:
    print("  WINNERS blocked:")
    for r in vol_blocked_winners:
        print("    ID={} | PnL=${:.4f} | Vol=${:.0f} | Side={}".format(
            r["id"], r["pnl"], r["volume"], r["side"]))
        print("      Q: {}".format(str(r["question"])[:90]))
        print("      Opened: {} | Closed: {}".format(r["opened_at"], r["closed_at"]))
        print()
else:
    print("  No winning bets blocked.")
    print()

vol_total = sum(r["pnl"] for r in vol_blocked_winners)
vol_saved = abs(sum(r["pnl"] for r in vol_blocked_losers))
print("  Winners blocked: {} (lost profit: ${:.4f})".format(len(vol_blocked_winners), vol_total))
print("  Losers prevented: {} (saved: ${:.4f})".format(len(vol_blocked_losers), vol_saved))
print()

# ============================================================
# 2. MULTI-FLIP GUARD (v16.16)
# Rule: If both sides traded within 4h window, and most recent close < 1h ago,
# block new entries.
# ============================================================
print("=" * 80)
print("2. MULTI-FLIP GUARD (v16.16)")
print("   Rule: Block entry if both sides traded within 4h and last close < 1h ago")
print("=" * 80)

flip_window_hours = 4.0
flip_cooldown_hours = 1.0
flip_blocked_winners = []
flip_blocked_losers = []
flip_ids = set()

for mid, preds in by_market.items():
    for i, p in enumerate(preds):
        # Simulate: at the time of this entry, would the guard have blocked it?
        t_open = datetime.fromisoformat(p["opened_at"].replace("Z", ""))
        window_start = t_open - timedelta(hours=flip_window_hours)

        # Find all prior predictions on this market that closed within the flip window
        prior_closed = [
            pr for pr in preds[:i]
            if pr["closed_at"] is not None
            and datetime.fromisoformat(pr["closed_at"].replace("Z", "")) > window_start
            and datetime.fromisoformat(pr["closed_at"].replace("Z", "")) <= t_open
        ]

        distinct_sides = set(pr["side"] for pr in prior_closed)

        if len(distinct_sides) >= 2:
            # Both sides traded in window. Check cooldown from most recent close.
            most_recent_close = max(
                datetime.fromisoformat(pr["closed_at"].replace("Z", ""))
                for pr in prior_closed
            )
            hours_since = (t_open - most_recent_close).total_seconds() / 3600
            if hours_since < flip_cooldown_hours:
                entry = {**p, "hours_since_close": hours_since}
                if p["pnl"] > 0:
                    flip_blocked_winners.append(entry)
                    flip_ids.add(p["id"])
                else:
                    flip_blocked_losers.append(entry)

if flip_blocked_winners:
    print("  WINNERS blocked:")
    for r in flip_blocked_winners:
        print("    ID={} | PnL=${:.4f} | Side={} | hrs_since={:.2f}".format(
            r["id"], r["pnl"], r["side"], r["hours_since_close"]))
        print("      Q: {}".format(str(r["question"])[:90]))
        print("      Opened: {} | Closed: {}".format(r["opened_at"], r["closed_at"]))
        print()
else:
    print("  No winning bets blocked.")
    print()

flip_total = sum(r["pnl"] for r in flip_blocked_winners)
flip_saved = abs(sum(r["pnl"] for r in flip_blocked_losers))
print("  Winners blocked: {} (lost profit: ${:.4f})".format(len(flip_blocked_winners), flip_total))
print("  Losers prevented: {} (saved: ${:.4f})".format(len(flip_blocked_losers), flip_saved))
print()

# ============================================================
# 3. OSCILLATION DAMPENER (v16.18)
# Rule: Markets with 6+ reversals (8pp swing) in 2h, net < 15%, capped to 1 pos.
# Position 2+ on these markets would be blocked.
# ============================================================
print("=" * 80)
print("3. OSCILLATION DAMPENER (v16.18)")
print("   Rule: Markets with 6+ reversals in 2h (net <15%) capped to 1 position")
print("=" * 80)

osc_max_rev = 6
osc_net_override = 0.15
osc_min_swing = 0.08
osc_lookback_hours = 2.0

osc_blocked_winners = []
osc_blocked_losers = []
osc_ids = set()

for mid, preds in by_market.items():
    for i, p in enumerate(preds):
        if i == 0:
            continue  # First position always allowed

        # Compute oscillation from odds_snapshots at time of entry
        t_open = datetime.fromisoformat(p["opened_at"].replace("Z", ""))
        window_start = (t_open - timedelta(hours=osc_lookback_hours)).strftime("%Y-%m-%dT%H:%M:%S")
        t_open_str = t_open.strftime("%Y-%m-%dT%H:%M:%S")

        snaps = db.execute(
            "SELECT yes_price, ts FROM odds_snapshots WHERE market_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
            (mid, window_start, t_open_str)
        ).fetchall()

        if len(snaps) < 2:
            continue

        prices = [s["yes_price"] for s in snaps]
        reversals = 0
        direction = None
        last_extreme = prices[0]

        for j in range(1, len(prices)):
            diff = prices[j] - last_extreme
            if abs(diff) >= osc_min_swing:
                new_dir = "up" if diff > 0 else "down"
                if direction is not None and new_dir != direction:
                    reversals += 1
                direction = new_dir
                last_extreme = prices[j]

        net_move = abs(prices[-1] - prices[0])
        is_oscillating = (reversals >= osc_max_rev and net_move < osc_net_override)

        if is_oscillating:
            # Check if there is already a position open (cap = 1)
            currently_open = sum(
                1 for pr in preds[:i]
                if pr["closed_at"] is None
                or datetime.fromisoformat(pr["closed_at"].replace("Z", "")) > t_open
            )
            if currently_open >= 1:
                entry = {**p, "reversals": reversals, "net_move": net_move}
                if p["pnl"] > 0:
                    osc_blocked_winners.append(entry)
                    osc_ids.add(p["id"])
                else:
                    osc_blocked_losers.append(entry)

if osc_blocked_winners:
    print("  WINNERS blocked:")
    for r in osc_blocked_winners:
        print("    ID={} | PnL=${:.4f} | Side={} | rev={} | net={:.2f}".format(
            r["id"], r["pnl"], r["side"], r["reversals"], r["net_move"]))
        print("      Q: {}".format(str(r["question"])[:90]))
        print("      Opened: {} | Closed: {}".format(r["opened_at"], r["closed_at"]))
        print()
else:
    print("  No winning bets blocked.")
    print()

osc_total = sum(r["pnl"] for r in osc_blocked_winners)
osc_saved = abs(sum(r["pnl"] for r in osc_blocked_losers))
print("  Winners blocked: {} (lost profit: ${:.4f})".format(len(osc_blocked_winners), osc_total))
print("  Losers prevented: {} (saved: ${:.4f})".format(len(osc_blocked_losers), osc_saved))
print()

# ============================================================
# 4. BURNED-MARKET GUARD (v16.19)
# Rule: If cumulative realised PnL on a market in last 4h <= -$2,
# cap to 1 position (effectively blocks position 2+ when burned).
# ============================================================
print("=" * 80)
print("4. BURNED-MARKET GUARD (v16.19)")
print("   Rule: Markets with cumulative realised PnL <= -$2 in 4h capped to 1 position")
print("=" * 80)

burned_lookback_hours = 4.0
burned_threshold = -2.00

burn_blocked_winners = []
burn_blocked_losers = []
burn_ids = set()

for mid, preds in by_market.items():
    for i, p in enumerate(preds):
        # At time of entry, what was cumulative realised PnL in lookback window?
        t_open = datetime.fromisoformat(p["opened_at"].replace("Z", ""))
        window_start = (t_open - timedelta(hours=burned_lookback_hours)).strftime("%Y-%m-%dT%H:%M:%S")
        t_open_str = t_open.strftime("%Y-%m-%dT%H:%M:%S")

        # All predictions on this market closed before entry, within lookback
        prior_closed = db.execute(
            "SELECT COALESCE(SUM(pnl), 0) as net_pnl FROM predictions "
            "WHERE market_id = ? AND closed_at IS NOT NULL AND closed_at > ? AND closed_at <= ?",
            (mid, window_start, t_open_str)
        ).fetchone()

        cum_pnl = prior_closed["net_pnl"] if prior_closed else 0
        is_burned = cum_pnl <= burned_threshold

        if is_burned:
            # Burned sets effective_max_positions = 1
            # Count currently open positions at time of entry
            currently_open = sum(
                1 for pr in preds[:i]
                if pr["closed_at"] is None
                or datetime.fromisoformat(pr["closed_at"].replace("Z", "")) > t_open
            )
            if currently_open >= 1:
                entry = {**p, "cum_pnl": cum_pnl, "open_count": currently_open}
                if p["pnl"] > 0:
                    burn_blocked_winners.append(entry)
                    burn_ids.add(p["id"])
                else:
                    burn_blocked_losers.append(entry)

if burn_blocked_winners:
    print("  WINNERS blocked:")
    for r in burn_blocked_winners:
        print("    ID={} | PnL=${:.4f} | Side={} | CumPnL=${:.2f} | Open={}".format(
            r["id"], r["pnl"], r["side"], r["cum_pnl"], r["open_count"]))
        print("      Q: {}".format(str(r["question"])[:90]))
        print("      Opened: {} | Closed: {}".format(r["opened_at"], r["closed_at"]))
        print()
else:
    print("  No winning bets blocked.")
    print()

burn_total = sum(r["pnl"] for r in burn_blocked_winners)
burn_saved = abs(sum(r["pnl"] for r in burn_blocked_losers))
print("  Winners blocked: {} (lost profit: ${:.4f})".format(len(burn_blocked_winners), burn_total))
print("  Losers prevented: {} (saved: ${:.4f})".format(len(burn_blocked_losers), burn_saved))
print()

# ============================================================
# DEDUPLICATED SUMMARY
# ============================================================
print("=" * 80)
print("DEDUPLICATED SUMMARY")
print("=" * 80)

all_blocked = vol_ids | flip_ids | osc_ids | burn_ids
print("  Volume guard IDs: {}".format(sorted(vol_ids)))
print("  Multi-flip guard IDs: {}".format(sorted(flip_ids)))
print("  Oscillation dampener IDs: {}".format(sorted(osc_ids)))
print("  Burned-market guard IDs: {}".format(sorted(burn_ids)))
print()

# Check overlaps
has_overlaps = False
for pid in sorted(all_blocked):
    guards = []
    if pid in vol_ids:
        guards.append("volume")
    if pid in flip_ids:
        guards.append("multi-flip")
    if pid in osc_ids:
        guards.append("oscillation")
    if pid in burn_ids:
        guards.append("burned-market")
    if len(guards) > 1:
        r = db.execute("SELECT pnl, question FROM predictions WHERE id=?", (pid,)).fetchone()
        g = ", ".join(guards)
        print("  OVERLAP: ID={} ({}) PnL=${:.4f} Q={}".format(pid, g, r["pnl"], str(r["question"])[:60]))
        has_overlaps = True

if not has_overlaps:
    print("  No overlaps between guards.")

dedup_total = 0
for pid in all_blocked:
    r = db.execute("SELECT pnl FROM predictions WHERE id=?", (pid,)).fetchone()
    if r:
        dedup_total += r["pnl"]

print()
print("  Unique blocked winning bets: {}".format(len(all_blocked)))
print("  DEDUPLICATED total lost profit: ${:.4f}".format(dedup_total))
print()
print("  Per-guard breakdown:")
print("    Volume guard:         ${:.4f} ({} bets)".format(vol_total, len(vol_ids)))
print("    Multi-flip guard:     ${:.4f} ({} bets)".format(flip_total, len(flip_ids)))
print("    Oscillation dampener: ${:.4f} ({} bets)".format(osc_total, len(osc_ids)))
print("    Burned-market guard:  ${:.4f} ({} bets)".format(burn_total, len(burn_ids)))

total_win_pnl = sum(p["pnl"] for p in winners)
total_loss_pnl = sum(p["pnl"] for p in losers)
print()
print("  CONTEXT:")
print("    Total momentum winners: {} (${:.2f})".format(len(winners), total_win_pnl))
print("    Total momentum losers:  {} (${:.2f})".format(len(losers), total_loss_pnl))
print("    Net momentum PnL: ${:.2f}".format(total_win_pnl + total_loss_pnl))
print("    Lost profit as pct of total wins: {:.1f}%".format(
    (dedup_total / total_win_pnl * 100) if total_win_pnl > 0 else 0))

db.close()
