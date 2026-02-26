import sqlite3
conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row
v = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
print(f"Schema version: {v[0] if v else 'not set'}")
cols = conn.execute("PRAGMA table_info(musk_markets)").fetchall()
print("musk_markets columns:")
for c in cols:
    print(f"  {c['name']:20} {c['type']}")
conn.close()
