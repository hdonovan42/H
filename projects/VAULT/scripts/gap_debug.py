import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

mid = "1333269"  # DeepSeek V4

# Count snapshots in each hour
print("SNAPSHOT DENSITY BY HOUR:")
rows = conn.execute(
    "SELECT substr(ts, 1, 13) as hour, COUNT(*) as cnt, "
    "ROUND(MIN(yes_price), 4) as lo, ROUND(MAX(yes_price), 4) as hi "
    "FROM odds_snapshots WHERE market_id = ? "
    "GROUP BY hour ORDER BY hour",
    (mid,)
).fetchall()
for r in rows:
    print(f"  {r['hour']}:00 | {r['cnt']:3} snaps | YES {r['lo']:.1%}-{r['hi']:.1%}")

# Total snapshots
total = conn.execute(
    "SELECT COUNT(*) as c FROM odds_snapshots WHERE market_id = ?", (mid,)
).fetchone()["c"]
print(f"\nTotal snapshots: {total}")

# Check for gaps > 5 minutes
print("\nGAPS > 5 MINUTES:")
all_snaps = conn.execute(
    "SELECT ts, yes_price FROM odds_snapshots WHERE market_id = ? ORDER BY ts ASC",
    (mid,)
).fetchall()
for i in range(1, len(all_snaps)):
    prev_ts = datetime.fromisoformat(all_snaps[i-1]["ts"].replace("Z", "+00:00"))
    curr_ts = datetime.fromisoformat(all_snaps[i]["ts"].replace("Z", "+00:00"))
    gap_min = (curr_ts - prev_ts).total_seconds() / 60
    if gap_min > 5:
        print(f"  {all_snaps[i-1]['ts'][:16]} -> {all_snaps[i]['ts'][:16]} "
              f"({gap_min:.0f} min gap) "
              f"YES {all_snaps[i-1]['yes_price']:.2%} -> {all_snaps[i]['yes_price']:.2%}")

# What does get_odds_history return right now?
print("\nCURRENT 1H WINDOW:")
h1 = conn.execute(
    "SELECT ts, yes_price FROM odds_snapshots "
    "WHERE market_id = ? AND ts > datetime('now', '-1 hours') ORDER BY ts ASC",
    (mid,)
).fetchall()
print(f"  {len(h1)} snapshots")
if h1:
    first = datetime.fromisoformat(h1[0]["ts"].replace("Z", "+00:00"))
    last = datetime.fromisoformat(h1[-1]["ts"].replace("Z", "+00:00"))
    span = (last - first).total_seconds() / 60
    print(f"  First: {h1[0]['ts'][:16]} YES={h1[0]['yes_price']:.2%}")
    print(f"  Last:  {h1[-1]['ts'][:16]} YES={h1[-1]['yes_price']:.2%}")
    print(f"  Span: {span:.1f} minutes")
    print(f"  v_1h would be: {h1[-1]['yes_price'] - h1[0]['yes_price']:+.2%}")

print("\nCURRENT 6H WINDOW:")
h6 = conn.execute(
    "SELECT ts, yes_price FROM odds_snapshots "
    "WHERE market_id = ? AND ts > datetime('now', '-6 hours') ORDER BY ts ASC",
    (mid,)
).fetchall()
print(f"  {len(h6)} snapshots")
if h6:
    first = datetime.fromisoformat(h6[0]["ts"].replace("Z", "+00:00"))
    last = datetime.fromisoformat(h6[-1]["ts"].replace("Z", "+00:00"))
    span = (last - first).total_seconds() / 60
    print(f"  First: {h6[0]['ts'][:16]} YES={h6[0]['yes_price']:.2%}")
    print(f"  Last:  {h6[-1]['ts'][:16]} YES={h6[-1]['yes_price']:.2%}")
    print(f"  Span: {span:.1f} minutes")
    print(f"  v_6h would be: {h6[-1]['yes_price'] - h6[0]['yes_price']:+.2%}")

conn.close()
