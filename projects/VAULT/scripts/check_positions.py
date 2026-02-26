import sqlite3
conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# List tables
tables = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall()
print("Tables:", [t[0] for t in tables])

# Check bets table
try:
    rows = conn.execute("SELECT * FROM bets ORDER BY rowid DESC LIMIT 5").fetchall()
    print("\nBETS:")
    for r in rows:
        print(dict(r))
except Exception as e:
    print(f"No bets table: {e}")

# Check predictions table
try:
    rows = conn.execute("SELECT * FROM predictions ORDER BY rowid DESC LIMIT 5").fetchall()
    print("\nPREDICTIONS:")
    for r in rows:
        print(dict(r))
except Exception as e:
    print(f"No predictions table: {e}")

# Check positions table
try:
    rows = conn.execute("SELECT * FROM positions ORDER BY rowid DESC LIMIT 5").fetchall()
    print("\nPOSITIONS:")
    for r in rows:
        print(dict(r))
except Exception as e:
    print(f"No positions table: {e}")

conn.close()
