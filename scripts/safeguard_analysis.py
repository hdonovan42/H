"""Analyze historical VAULT predictions against all 4 safeguards (v16.16-v16.19)."""
import sqlite3
from datetime import datetime, timedelta
from collections import defaultdict

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# Get all closed momentum predictions
rows = conn.execute(
    "SELECT p.id, p.market_id, p.question, p.side, p.cost_basis, p.pnl, "
    "p.opened_at, p.closed_at, p.resolution, p.entry_reasoning, m.volume "
    "FROM predictions p "
    "LEFT JOIN musk_markets m ON p.market_id = m.market_id "
    "WHERE p.status = 'closed' AND p.pnl IS NOT NULL "
    "AND (p.entry_reasoning LIKE 'Momentum%' "
    "     OR p.entry_reasoning LIKE 'Sharp move%' "
    "     OR p.entry_reasoning LIKE '%OSCILLATION%' "
    "     OR p.entry_reasoning LIKE '%BURNED%') "
    "ORDER BY p.opened_at"
).fetchall()

print("=== ALL CLOSED MOMENTUM PREDICTIONS: %d ===" % len(rows))
print()

# ── SAFEGUARD 1: Volume Guard ──
print("=" * 70)
print("SAFEGUARD 1: VOLUME GUARD (volume < $10,000)")
print("=" * 70)
vol_losers = []
vol_winners = []
for r in rows:
    vol = r["volume"] or 0
    if vol < 10000 and vol > 0:
        if r["pnl"] < 0:
            vol_losers.append(r)
        elif r["pnl"] > 0:
            vol_winners.append(r)

print("\nLOSING bets prevented (savings):")
vol_loss_total = 0
for r in vol_losers:
    vol_loss_total += abs(r["pnl"])
    print("  [%d] $%.2f loss | %s %s $%.2f | vol=$%.0f | %s" % (
        r["id"], r["pnl"], r["side"], r["resolution"] or "sold",
        r["cost_basis"], r["volume"] or 0, r["question"][:50]))
print("  TOTAL SAVINGS: $%.2f (%d bets)" % (vol_loss_total, len(vol_losers)))

print("\nWINNING bets blocked (lost profit):")
vol_win_total = 0
for r in vol_winners:
    vol_win_total += r["pnl"]
    print("  [%d] +$%.2f | %s %s $%.2f | vol=$%.0f | %s" % (
        r["id"], r["pnl"], r["side"], r["resolution"] or "sold",
        r["cost_basis"], r["volume"] or 0, r["question"][:50]))
print("  TOTAL LOST PROFIT: $%.2f (%d bets)" % (vol_win_total, len(vol_winners)))
print("  NET BENEFIT: $%.2f" % (vol_loss_total - vol_win_total))

# ── SAFEGUARD 2: Multi-flip Guard ──
print()
print("=" * 70)
print("SAFEGUARD 2: MULTI-FLIP GUARD (both sides within 4h)")
print("=" * 70)

by_market = defaultdict(list)
for r in rows:
    by_market[r["market_id"]].append(r)

flip_losers = []
flip_winners = []
flip_seen = set()
for mid, preds in by_market.items():
    sorted_p = sorted(preds, key=lambda x: x["opened_at"])
    for i, p in enumerate(sorted_p):
        # Check if there's a different-side closed pred within 4h before this one opened
        for prev in sorted_p[:i]:
            if prev["side"] != p["side"] and prev["closed_at"]:
                try:
                    prev_close = datetime.fromisoformat(prev["closed_at"].replace("Z", "+00:00"))
                    cur_open = datetime.fromisoformat(p["opened_at"].replace("Z", "+00:00"))
                    gap_h = (cur_open - prev_close).total_seconds() / 3600
                    if 0 <= gap_h <= 4:
                        # Also need a THIRD trade (second flip) to trigger guard
                        # Guard fires when we've traded both sides already
                        sides_before = set()
                        for earlier in sorted_p[:i]:
                            if earlier["closed_at"]:
                                sides_before.add(earlier["side"])
                        if len(sides_before) >= 2 and p["id"] not in flip_seen:
                            flip_seen.add(p["id"])
                            if p["pnl"] < 0:
                                flip_losers.append(p)
                            elif p["pnl"] > 0:
                                flip_winners.append(p)
                            break
                except (ValueError, TypeError):
                    pass

print("\nLOSING bets prevented (savings):")
flip_loss_total = 0
for r in flip_losers:
    flip_loss_total += abs(r["pnl"])
    print("  [%d] $%.2f loss | %s $%.2f | %s" % (
        r["id"], r["pnl"], r["side"], r["cost_basis"], r["question"][:55]))
print("  TOTAL SAVINGS: $%.2f (%d bets)" % (flip_loss_total, len(flip_losers)))

print("\nWINNING bets blocked (lost profit):")
flip_win_total = 0
for r in flip_winners:
    flip_win_total += r["pnl"]
    print("  [%d] +$%.2f | %s $%.2f | %s" % (
        r["id"], r["pnl"], r["side"], r["cost_basis"], r["question"][:55]))
print("  TOTAL LOST PROFIT: $%.2f (%d bets)" % (flip_win_total, len(flip_winners)))
print("  NET BENEFIT: $%.2f" % (flip_loss_total - flip_win_total))

# ── SAFEGUARD 3: Oscillation Dampener (3+ positions → cap to 1) ──
print()
print("=" * 70)
print("SAFEGUARD 3: OSCILLATION DAMPENER (3+ positions per market, cap to 1)")
print("=" * 70)

osc_losers = []
osc_winners = []
for mid, preds in by_market.items():
    if len(preds) < 3:
        continue
    sorted_p = sorted(preds, key=lambda x: x["opened_at"])
    # First position kept, positions 2+ would be blocked
    for p in sorted_p[1:]:
        if p["pnl"] < 0:
            osc_losers.append(p)
        elif p["pnl"] > 0:
            osc_winners.append(p)

print("\nLOSING bets prevented (positions 2+ on 3+ position markets):")
osc_loss_total = 0
for r in osc_losers:
    osc_loss_total += abs(r["pnl"])
    print("  [%d] $%.2f loss | %s $%.2f | %s" % (
        r["id"], r["pnl"], r["side"], r["cost_basis"], r["question"][:55]))
print("  TOTAL SAVINGS: $%.2f (%d bets)" % (osc_loss_total, len(osc_losers)))

print("\nWINNING bets blocked (positions 2+ on 3+ position markets):")
osc_win_total = 0
for r in osc_winners:
    osc_win_total += r["pnl"]
    print("  [%d] +$%.2f | %s $%.2f | %s" % (
        r["id"], r["pnl"], r["side"], r["cost_basis"], r["question"][:55]))
print("  TOTAL LOST PROFIT: $%.2f (%d bets)" % (osc_win_total, len(osc_winners)))
print("  NET BENEFIT: $%.2f" % (osc_loss_total - osc_win_total))

# ── SAFEGUARD 4: Burned-market Guard ──
print()
print("=" * 70)
print("SAFEGUARD 4: BURNED-MARKET GUARD (cum. loss > $2 then block)")
print("=" * 70)

burn_losers = []
burn_winners = []
for mid, preds in by_market.items():
    sorted_p = sorted(preds, key=lambda x: x["opened_at"])
    cum_pnl = 0
    burned = False
    for p in sorted_p:
        if burned:
            if p["pnl"] < 0:
                burn_losers.append(p)
            elif p["pnl"] > 0:
                burn_winners.append(p)
        else:
            if p["closed_at"] and p["pnl"] is not None:
                cum_pnl += p["pnl"]
                if cum_pnl <= -2.0:
                    burned = True

print("\nLOSING bets prevented (after cumulative loss > $2):")
burn_loss_total = 0
for r in burn_losers:
    burn_loss_total += abs(r["pnl"])
    print("  [%d] $%.2f loss | %s $%.2f | %s" % (
        r["id"], r["pnl"], r["side"], r["cost_basis"], r["question"][:55]))
print("  TOTAL SAVINGS: $%.2f (%d bets)" % (burn_loss_total, len(burn_losers)))

print("\nWINNING bets blocked (after cumulative loss > $2):")
burn_win_total = 0
for r in burn_winners:
    burn_win_total += r["pnl"]
    print("  [%d] +$%.2f | %s $%.2f | %s" % (
        r["id"], r["pnl"], r["side"], r["cost_basis"], r["question"][:55]))
print("  TOTAL LOST PROFIT: $%.2f (%d bets)" % (burn_win_total, len(burn_winners)))
print("  NET BENEFIT: $%.2f" % (burn_loss_total - burn_win_total))

# ── DEDUPLICATED SUMMARY ──
print()
print("=" * 70)
print("DEDUPLICATED SUMMARY (each bet counted once, first guard that fires)")
print("=" * 70)

# Assign each prediction to the first guard that would catch it
all_flagged = {}  # id -> (guard, pnl)
for r in vol_losers + vol_winners:
    if r["id"] not in all_flagged:
        all_flagged[r["id"]] = ("volume", r["pnl"])
for r in flip_losers + flip_winners:
    if r["id"] not in all_flagged:
        all_flagged[r["id"]] = ("multi-flip", r["pnl"])
for r in osc_losers + osc_winners:
    if r["id"] not in all_flagged:
        all_flagged[r["id"]] = ("oscillation", r["pnl"])
for r in burn_losers + burn_winners:
    if r["id"] not in all_flagged:
        all_flagged[r["id"]] = ("burned-market", r["pnl"])

dedup_savings = {"volume": 0, "multi-flip": 0, "oscillation": 0, "burned-market": 0}
dedup_lost = {"volume": 0, "multi-flip": 0, "oscillation": 0, "burned-market": 0}
dedup_count_save = {"volume": 0, "multi-flip": 0, "oscillation": 0, "burned-market": 0}
dedup_count_lost = {"volume": 0, "multi-flip": 0, "oscillation": 0, "burned-market": 0}

for pid, (guard, pnl) in all_flagged.items():
    if pnl < 0:
        dedup_savings[guard] += abs(pnl)
        dedup_count_save[guard] += 1
    elif pnl > 0:
        dedup_lost[guard] += pnl
        dedup_count_lost[guard] += 1

total_save = sum(dedup_savings.values())
total_lost = sum(dedup_lost.values())

for guard in ["volume", "multi-flip", "oscillation", "burned-market"]:
    s = dedup_savings[guard]
    l = dedup_lost[guard]
    cs = dedup_count_save[guard]
    cl = dedup_count_lost[guard]
    print("  %-15s | Saved $%6.2f (%d bets) | Lost $%5.2f (%d bets) | Net $%+.2f" % (
        guard, s, cs, l, cl, s - l))

print("  " + "-" * 68)
print("  %-15s | Saved $%6.2f           | Lost $%5.2f           | Net $%+.2f" % (
    "TOTAL", total_save, total_lost, total_save - total_lost))
