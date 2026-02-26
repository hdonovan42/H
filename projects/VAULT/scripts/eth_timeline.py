import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# ETH market detailed timeline
mid = None
rows = conn.execute("""
    SELECT market_id FROM musk_markets WHERE question LIKE '%Ethereum%1,900%'
""").fetchall()
if rows:
    mid = rows[0]["market_id"]

if mid:
    snaps = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    print(f"ETH >$1900 market ({mid}): {len(snaps)} snapshots in 24h")
    # Show hourly summary
    by_hour = {}
    for s in snaps:
        hour = s["ts"][:13]
        if hour not in by_hour:
            by_hour[hour] = {"first": s["yes_price"], "last": s["yes_price"], "count": 0}
        by_hour[hour]["last"] = s["yes_price"]
        by_hour[hour]["count"] += 1
    for hour, data in sorted(by_hour.items()):
        delta = data["last"] - data["first"]
        print(f"  {hour}:00 | {data['first']:.0%} -> {data['last']:.0%} ({delta:+.1%}) | {data['count']} snaps")

    # Check: at any 1h window, was there a >= 10% move?
    print("\n  Max 1h velocity at each snapshot:")
    big_moves = 0
    for i, s in enumerate(snaps):
        # Find earliest snapshot >= 1h before this one
        current_ts = datetime.fromisoformat(s["ts"].replace("Z", "+00:00"))
        for j in range(i):
            ref_ts = datetime.fromisoformat(snaps[j]["ts"].replace("Z", "+00:00"))
            gap_min = (current_ts - ref_ts).total_seconds() / 60
            if 55 <= gap_min <= 70:  # roughly 1h ago
                v1h = s["yes_price"] - snaps[j]["yes_price"]
                if abs(v1h) >= 0.05:
                    big_moves += 1
                    print(f"    {snaps[j]['ts'][:16]} -> {s['ts'][:16]}: {v1h:+.1%} ({gap_min:.0f}min)")
                break
    if big_moves == 0:
        print("    No 1h velocity >= 5% found")

# Also check: what were the ACTUAL velocity values the system calculated?
print("\n=== HISTORICAL PROFITABLE ANALYSIS ===")
print("Win rate by entry reasoning pattern:")
for pattern in ["Sharp move", "momentum", "z-gate"]:
    row = conn.execute("""
        SELECT COUNT(*) as n,
               SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
               ROUND(SUM(pnl), 4) as pnl
        FROM predictions WHERE status = 'closed' AND entry_reasoning LIKE ?
    """, (f"%{pattern}%",)).fetchone()
    if row["n"]:
        print(f"  '{pattern}': {row['n']} bets, {row['wins']}W ({row['wins']/row['n']*100:.0f}%), PnL ${row['pnl']}")

conn.close()
