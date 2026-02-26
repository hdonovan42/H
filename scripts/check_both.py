import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

preds = conn.execute("SELECT * FROM predictions WHERE id IN (220, 221)").fetchall()
snap = conn.execute("""
    SELECT yes_price, ts FROM odds_snapshots
    WHERE market_id = (SELECT market_id FROM predictions WHERE id=220)
    ORDER BY ts DESC LIMIT 1
""").fetchone()

yes_price = snap["yes_price"]
no_price = 1 - yes_price
print(f"Current odds: YES={yes_price:.2f} NO={no_price:.2f} (as of {snap['ts']})")
print()

total_cost = 0
total_value = 0
for p in preds:
    our_price = yes_price if p["side"] == "YES" else no_price
    val = p["shares"] * our_price
    pnl = val - p["cost_basis"]
    roi = pnl / p["cost_basis"] * 100
    total_cost += p["cost_basis"]
    total_value += val
    print(f"[{p['id']}] {p['side']:3s} | entry={p['entry_odds']:.2f} | now={our_price:.2f} | shares={p['shares']:.2f} | cost=${p['cost_basis']:.2f} | val=${val:.2f} | PnL=${pnl:+.2f} ({roi:+.1f}%)")

print(f"\nCombined: cost=${total_cost:.2f} | value=${total_value:.2f} | PnL=${total_value - total_cost:+.2f}")
print(f"If OG wins  (YES=1): ${preds[0]['shares']:.2f} + $0 = ${preds[0]['shares']:.2f} (net ${preds[0]['shares'] - total_cost:+.2f})")
print(f"If TL wins  (NO=1):  $0 + ${preds[1]['shares']:.2f} = ${preds[1]['shares']:.2f} (net ${preds[1]['shares'] - total_cost:+.2f})")
