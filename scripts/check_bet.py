"""Check the latest bet and current state."""
import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

# Latest cycles (including the pending one)
print("=== LATEST 5 CYCLES ===")
rows = conn.execute("SELECT * FROM cycles ORDER BY id DESC LIMIT 5").fetchall()
for r in rows:
    print(f"  #{r['id']} | {r['ts_start']} → {r['ts_end'] or 'pending'} | {r['action']:10s} | cost=${r['total_cost'] or 0:.4f} | bal=${r['balance_after'] or 0:.2f}")
    if r['reasoning']:
        print(f"    reasoning: {r['reasoning'][:200]}")

# Active predictions
print("\n=== ACTIVE PREDICTIONS ===")
preds = conn.execute("SELECT * FROM predictions WHERE status='active' ORDER BY opened_at DESC").fetchall()
if not preds:
    print("  (none)")
for p in preds:
    print(f"  [{p['id']}] {p['opened_at']} | {p['side']:3s} | shares={p['shares']:.2f} | entry={p['entry_odds']:.2f} | cost=${p['cost_basis']:.2f} | edge={p['entry_edge']:.1%}")
    print(f"    {p['question'][:80]}")
    print(f"    reasoning: {(p['entry_reasoning'] or '')[:150]}")

# Current balance
bal = conn.execute("SELECT balance, burn_rate, runway_days, total_pnl, positions_value FROM objectives ORDER BY id DESC LIMIT 1").fetchone()
if bal:
    print(f"\n=== CURRENT STATE ===")
    print(f"  Balance: ${bal['balance']:.2f}")
    print(f"  Positions value: ${bal['positions_value']:.2f}")
    print(f"  Total value: ${bal['balance'] + bal['positions_value']:.2f}")
    print(f"  Burn rate: ${bal['burn_rate']:.4f}/cycle")
    print(f"  Runway: {bal['runway_days']:.0f}d")
    print(f"  Total PnL: ${bal['total_pnl']:+.2f}")
