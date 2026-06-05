#!/usr/bin/env python3
"""Print kv['last_digest_id'] (0 if unset). Tiny helper so the digest watcher can poll
the watch's progress over SSH without an inline one-liner."""
import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(os.path.dirname(HERE), "data", "waymo.db")
con = sqlite3.connect(DB)
row = con.execute("SELECT value FROM kv WHERE key='last_digest_id'").fetchone()
print(row[0] if row else 0)
con.close()
