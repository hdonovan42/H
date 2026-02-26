import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

# All Dota 2 predictions
print("=== ALL DOTA 2 PREDICTIONS ===")
preds = conn.execute("""
    SELECT id, status, side, shares, entry_odds, cost_basis, pnl, opened_at, closed_at, entry_reasoning
    FROM predictions WHERE question LIKE '%OG vs Team Liquid%'
    ORDER BY id
""").fetchall()

total_cost = 0
total_pnl = 0
for p in preds:
    pnl_str = f"${p['pnl']:+.2f}" if p['pnl'] is not None else "open"
    total_cost += p["cost_basis"]
    if p["pnl"] is not None:
        total_pnl += p["pnl"]
    print(f"  [{p['id']}] {p['status']:6s} | {p['side']:3s} @ {p['entry_odds']:.2f} | ${p['cost_basis']:.2f} | pnl={pnl_str}")
    print(f"    {p['opened_at']} → {p['closed_at'] or 'open'}")
    print(f"    {(p['entry_reasoning'] or '')[:120]}")
    print()

# Current value of open positions
snap = conn.execute("""
    SELECT yes_price FROM odds_snapshots
    WHERE market_id = (SELECT market_id FROM predictions WHERE id=220)
    ORDER BY ts DESC LIMIT 1
""").fetchone()
if snap:
    yes = snap["yes_price"]
    print(f"Current odds: YES={yes:.2f} NO={1-yes:.2f}")
    open_value = 0
    for p in preds:
        if p["status"] == "open":
            price = yes if p["side"] == "YES" else (1 - yes)
            val = p["shares"] * price
            open_value += val
            print(f"  [{p['id']}] {p['side']} value: ${val:.2f}")
    print(f"\nTotal invested: ${total_cost:.2f}")
    print(f"Realised PnL: ${total_pnl:+.2f}")
    print(f"Open value: ${open_value:.2f}")
    print(f"Net (realised + open - cost of open): see above")
