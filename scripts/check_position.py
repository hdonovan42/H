import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

pred = conn.execute("SELECT * FROM predictions WHERE id=220").fetchone()
market_id = pred["market_id"]

snap = conn.execute("SELECT * FROM odds_snapshots WHERE market_id=? ORDER BY ts DESC LIMIT 1", (market_id,)).fetchone()
if snap:
    yes_price = snap["yes_price"]
    current_val = pred["shares"] * yes_price
    unrealised = current_val - pred["cost_basis"]
    roi = unrealised / pred["cost_basis"] * 100
    print(f"Market: {pred['question']}")
    print(f"Side: {pred['side']} | Entry: {pred['entry_odds']:.2f} | Current YES: {yes_price:.2f}")
    print(f"Shares: {pred['shares']:.2f} | Cost: ${pred['cost_basis']:.2f}")
    print(f"Current value: ${current_val:.2f} | Unrealised PnL: ${unrealised:+.2f} ({roi:+.1f}%)")
    print(f"Latest snap: {snap['ts']}")

print()
print("Odds trajectory (last 10 snapshots):")
snaps = conn.execute("SELECT ts, yes_price FROM odds_snapshots WHERE market_id=? ORDER BY ts DESC LIMIT 10", (market_id,)).fetchall()
for s in reversed(list(snaps)):
    print(f"  {s['ts']} | YES={s['yes_price']:.2f}")

# Also check latest cycle
print()
print("Latest 3 cycles:")
cycles = conn.execute("SELECT id, ts_start, action, reasoning, balance_after FROM cycles ORDER BY id DESC LIMIT 3").fetchall()
for c in cycles:
    print(f"  #{c['id']} | {c['ts_start']} | {c['action']:10s} | bal=${c['balance_after'] or 0:.2f} | {(c['reasoning'] or '')[:100]}")
