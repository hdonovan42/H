import sqlite3, sys

conn = sqlite3.connect(sys.argv[1])

print("=== LAST 20 CYCLES ===")
rows = conn.execute("SELECT id, ts_start, action, reasoning, total_cost, balance_after FROM cycles ORDER BY id DESC LIMIT 20").fetchall()
for r in rows:
    reason = (r[3] or "")[:120]
    cost = r[4] or 0
    bal = r[5] or 0
    print(f"  #{r[0]} | {r[1]} | {r[2]:20s} | ${cost:.4f} | bal=${bal:.2f} | {reason}")

print("\n=== RECENT BETS (last 10) ===")
bets = conn.execute("SELECT id, ts_start, action, asset, reasoning FROM cycles WHERE action IN ('bet','buy') ORDER BY id DESC LIMIT 10").fetchall()
if not bets:
    print("  (none)")
for b in bets:
    print(f"  #{b[0]} | {b[1]} | {b[2]} | {(b[3] or '')[:50]} | {(b[4] or '')[:80]}")

print("\n=== HAIKU MOMENTUM CALLS (last 15) ===")
api = conn.execute("SELECT ts, purpose, cost_usd FROM api_calls WHERE purpose LIKE '%momentum%' OR purpose LIKE '%haiku%' ORDER BY ts DESC LIMIT 15").fetchall()
if not api:
    print("  (none)")
for a in api:
    print(f"  {a[0]} | {a[1]:40s} | ${a[2]:.4f}")

print("\n=== ALL API CALLS (last 20) ===")
api2 = conn.execute("SELECT ts, model, purpose, cost_usd FROM api_calls ORDER BY ts DESC LIMIT 20").fetchall()
for a in api2:
    print(f"  {a[0]} | {a[1]:40s} | {a[2]:30s} | ${a[3]:.4f}")

print("\n=== OPEN PREDICTIONS ===")
preds = conn.execute("SELECT question, side, shares, entry_odds, cost_basis, entry_edge, opened_at FROM predictions WHERE status='active' ORDER BY opened_at DESC").fetchall()
if not preds:
    print("  (none)")
for p in preds:
    print(f"  {p[6]} | {p[0][:60]} | {p[1]} | shares={p[2]} | entry={p[3]:.2f} | cost=${p[4]:.2f} | edge={p[5]:.1f}%")

print("\n=== LAST 5 CLOSED PREDICTIONS ===")
closed = conn.execute("SELECT question, side, resolution, pnl, opened_at, closed_at FROM predictions WHERE status != 'active' ORDER BY closed_at DESC LIMIT 5").fetchall()
for c in closed:
    print(f"  {c[4]} → {c[5]} | {c[2]:6s} | pnl=${c[3]:+.2f} | {c[0][:60]} | {c[1]}")
