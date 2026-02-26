import sqlite3
conn = sqlite3.connect("vault.db")

# Test the datetime function
r = conn.execute("SELECT datetime('now') as now, datetime('now', '-1 hours') as one_h_ago").fetchone()
print(f"now: {r[0]}")
print(f"1h ago: {r[1]}")

# Test the concatenation approach used in get_odds_history
hours = 1
r2 = conn.execute("SELECT datetime('now', ? || ' hours') as result", (f"-{hours}",)).fetchone()
print(f"concat approach: {r2[0]}")

# Test with the actual market query
mid = "1333269"
r3 = conn.execute(
    "SELECT COUNT(*) as c, MIN(ts) as first_ts, MAX(ts) as last_ts "
    "FROM odds_snapshots WHERE market_id = ? AND ts > datetime('now', ? || ' hours')",
    (mid, f"-{hours}")
).fetchone()
print(f"\nQuery with hours={hours}: {r3[0]} rows, first={r3[1]}, last={r3[2]}")

# Direct test with hardcoded modifier
r4 = conn.execute(
    "SELECT COUNT(*) as c, MIN(ts) as first_ts, MAX(ts) as last_ts "
    "FROM odds_snapshots WHERE market_id = ? AND ts > datetime('now', '-1 hours')",
    (mid,)
).fetchone()
print(f"Hardcoded -1 hours: {r4[0]} rows, first={r4[1]}, last={r4[2]}")

# Check: is the ts format correct? Compare formats
sample = conn.execute("SELECT ts FROM odds_snapshots WHERE market_id = ? LIMIT 1", (mid,)).fetchone()
print(f"\nSample ts format: '{sample[0]}'")
print(f"datetime('now') format: '{r[0]}'")

# The issue might be that odds_snapshots.ts has milliseconds but datetime('now') doesn't
# Check string comparison
r5 = conn.execute(
    "SELECT ? > datetime('now', '-1 hours') as compare",
    (sample[0],)
).fetchone()
print(f"Sample ts > 1h ago: {r5[0]}")

# What about strftime with milliseconds?
r6 = conn.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') as full_ts").fetchone()
print(f"strftime with ms: '{r6[0]}'")

conn.close()
