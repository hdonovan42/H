"""Check what velocity alerts are firing and what Haiku is saying."""
import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

# Smart money log for today
print("=== SMART MONEY LOG (today) ===")
rows = conn.execute("""
    SELECT ts, question, action_taken, side, market_odds, v_1h, v_6h, z_1h, confidence
    FROM smart_money_log
    WHERE ts > '2026-02-19T00:00:00'
    ORDER BY ts DESC
    LIMIT 30
""").fetchall()

if not rows:
    print("  (none today)")
else:
    for r in rows:
        q = (r["question"] or "")[:55]
        v1h = r["v_1h"] or 0
        z = r["z_1h"] or 0
        conf = r["confidence"] or 0
        print(f"  {r['ts']} | {r['action_taken']:18s} | {r['side'] or '?':3s} @ {r['market_odds'] or 0:.2f} | v1h={v1h:+.1%} z={z:+.1f} conf={conf:.2f} | {q}")

# Markets with biggest recent moves
print("\n=== MARKETS WITH BIGGEST 1H MOVES ===")
movers = conn.execute("""
    SELECT market_id,
           MIN(yes_price) as low,
           MAX(yes_price) as high,
           MAX(yes_price) - MIN(yes_price) as swing,
           COUNT(*) as snaps
    FROM odds_snapshots
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    GROUP BY market_id
    HAVING swing > 0.02
    ORDER BY swing DESC
    LIMIT 10
""").fetchall()
if movers:
    for m in movers:
        q_row = conn.execute("SELECT question FROM musk_markets WHERE market_id = ?", (m["market_id"],)).fetchone()
        q = (q_row["question"] if q_row else m["market_id"])[:55]
        print(f"  swing={m['swing']:+.1%} | low={m['low']:.2f} high={m['high']:.2f} | {m['snaps']} snaps | {q}")
else:
    print("  (no markets with >2% swing in last hour)")

# What about 6h window?
print("\n=== MARKETS WITH BIGGEST 6H MOVES ===")
movers6 = conn.execute("""
    SELECT market_id,
           MIN(yes_price) as low,
           MAX(yes_price) as high,
           MAX(yes_price) - MIN(yes_price) as swing,
           COUNT(*) as snaps
    FROM odds_snapshots
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
    GROUP BY market_id
    HAVING swing > 0.05
    ORDER BY swing DESC
    LIMIT 10
""").fetchall()
if movers6:
    for m in movers6:
        q_row = conn.execute("SELECT question FROM musk_markets WHERE market_id = ?", (m["market_id"],)).fetchone()
        q = (q_row["question"] if q_row else m["market_id"])[:55]
        print(f"  swing={m['swing']:+.1%} | low={m['low']:.2f} high={m['high']:.2f} | {m['snaps']} snaps | {q}")
else:
    print("  (no markets with >5% swing in last 6h)")

# Stats
total_mkts = conn.execute("SELECT COUNT(DISTINCT market_id) FROM musk_markets").fetchone()[0]
total_snaps_1h = conn.execute("""
    SELECT COUNT(*) FROM odds_snapshots
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
""").fetchone()[0]
print(f"\n  Total markets tracked: {total_mkts}")
print(f"  Snapshots in last 1h: {total_snaps_1h}")

# How many velocity_alert edges in recent pipeline runs?
print("\n=== RECENT PIPELINE RUNS ===")
pipe_rows = conn.execute("""
    SELECT id, ts, cycle_id, edge_count, tweet_count, market_count
    FROM pipeline_runs
    ORDER BY id DESC
    LIMIT 5
""").fetchall()
for p in pipe_rows:
    print(f"  run #{p['id']} | cycle {p['cycle_id']} | {p['ts']} | edges={p['edge_count']} tweets={p['tweet_count']} mkts={p['market_count']}")
