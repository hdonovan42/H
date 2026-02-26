import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])

# Check if there's a momentum_log or similar table
tables = [t[0] for t in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print("=== ALL TABLES ===")
print(", ".join(tables))

# Look for velocity alerts table
for t in tables:
    if 'velocity' in t.lower() or 'alert' in t.lower() or 'momentum' in t.lower():
        cols = [x[1] for x in conn.execute(f"PRAGMA table_info({t})").fetchall()]
        cnt = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"\n{t}: {cnt} rows, cols={cols}")
        if cnt > 0:
            rows = conn.execute(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT 5").fetchall()
            for r in rows:
                print(f"  {r}")

# Check cycle reasoning for momentum calls that didn't result in bets
print("\n=== CYCLES WITH HAIKU CALLS TODAY (since 09:00) ===")
# Get cycle IDs that had haiku calls today
cycle_ids = conn.execute("""
    SELECT DISTINCT cycle_id FROM api_calls
    WHERE purpose='momentum_validation' AND ts > '2026-02-19T09:00:00'
    ORDER BY cycle_id DESC LIMIT 20
""").fetchall()
for (cid,) in cycle_ids:
    cycle = conn.execute("SELECT id, ts_start, action, reasoning FROM cycles WHERE id=?", (cid,)).fetchone()
    if cycle:
        reason = (cycle[3] or "")[:200]
        print(f"  #{cycle[0]} | {cycle[1]} | {cycle[2]:10s} | {reason}")

# Check what the momentum prompts looked like recently
print("\n=== SENTINEL ALERTS (last 10) ===")
if 'sentinel_alerts' in tables:
    cols = [x[1] for x in conn.execute("PRAGMA table_info(sentinel_alerts)").fetchall()]
    print(f"  cols: {cols}")
    rows = conn.execute("SELECT * FROM sentinel_alerts ORDER BY rowid DESC LIMIT 10").fetchall()
    for r in rows:
        print(f"  {r}")
