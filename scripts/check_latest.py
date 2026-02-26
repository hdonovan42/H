import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

rows = conn.execute("SELECT id, ts_start, action, reasoning, balance_after FROM cycles ORDER BY id DESC LIMIT 8").fetchall()
for r in rows:
    reason = (r["reasoning"] or "")[:100]
    bal = r["balance_after"] or 0
    print(f"  #{r['id']} | {r['ts_start']} | {r['action']:10s} | bal=${bal:.2f} | {reason}")

print()
print("Open predictions:")
preds = conn.execute("SELECT id, question, side, shares, entry_odds, cost_basis FROM predictions WHERE status='open'").fetchall()
for p in preds:
    print(f"  [{p['id']}] {p['side']:3s} @ {p['entry_odds']:.2f} | ${p['cost_basis']:.2f} | {p['question'][:60]}")

snap = conn.execute("""
    SELECT ts, yes_price FROM odds_snapshots
    WHERE market_id = (SELECT market_id FROM predictions WHERE id=220)
    ORDER BY ts DESC LIMIT 1
""").fetchone()
if snap:
    print(f"\nCurrent YES price: {snap['yes_price']:.2f} (as of {snap['ts']})")
