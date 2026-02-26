import sqlite3
conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT question, game_start_time, event_title FROM musk_markets "
    "WHERE game_start_time IS NOT NULL AND game_start_time != '' "
    "ORDER BY last_seen DESC LIMIT 10"
).fetchall()
for r in rows:
    print(f"  start={r['game_start_time']} | evt={r['event_title'][:30] if r['event_title'] else 'n/a'} | {r['question'][:55]}")
conn.close()
