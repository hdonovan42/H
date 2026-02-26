import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# Last bet placed
last_bet = conn.execute("""
SELECT id, side, question, cost_basis, entry_odds, opened_at, status, pnl, entry_reasoning
FROM predictions ORDER BY opened_at DESC LIMIT 5
""").fetchall()
print("LAST 5 PREDICTIONS:")
for p in last_bet:
    print(f"  [{p['id']}] {p['status']:6} | {p['side']:3} @ {p['entry_odds']:.0%} | ${p['cost_basis']:.2f} | {p['opened_at'][:16]} | {p['question'][:55]}")
    if p['pnl'] is not None:
        print(f"         P&L: ${p['pnl']:+.2f} | {(p['entry_reasoning'] or '')[:60]}")

# Recent cycles with actions (not hold/auto-hold)
print("\nRECENT NON-HOLD CYCLES:")
actions = conn.execute("""
SELECT id, ts_start, action, reasoning, total_cost, balance_after
FROM cycles WHERE action NOT IN ('hold', 'pending') AND action IS NOT NULL
ORDER BY id DESC LIMIT 10
""").fetchall()
for c in actions:
    print(f"  Cycle {c['id']:5} | {c['ts_start'][:16]} | {c['action']:15} | ${c['total_cost']:.4f} | {(c['reasoning'] or '')[:60]}")

# How many cycles in last 7 hours
print("\nCYCLES LAST 7 HOURS:")
recent = conn.execute("""
SELECT COUNT(*) as total,
  SUM(CASE WHEN action = 'hold' THEN 1 ELSE 0 END) as holds,
  SUM(CASE WHEN action = 'bet' THEN 1 ELSE 0 END) as bets,
  SUM(CASE WHEN action NOT IN ('hold', 'bet') AND action IS NOT NULL THEN 1 ELSE 0 END) as other,
  ROUND(SUM(total_cost), 4) as cost
FROM cycles WHERE ts_start > datetime('now', '-7 hours')
""").fetchone()
print(f"  Total: {recent['total']} | Holds: {recent['holds']} | Bets: {recent['bets']} | Other: {recent['other']} | Cost: ${recent['cost'] or 0}")

# Momentum skip reasons in last 7 hours (from smart_money_log)
print("\nMOMENTUM SKIPS (last 7h from smart_money_log):")
skips = conn.execute("""
SELECT action_taken, COUNT(*) as cnt
FROM smart_money_log WHERE ts > datetime('now', '-7 hours')
GROUP BY action_taken ORDER BY cnt DESC
""").fetchall()
for s in skips:
    print(f"  {s['action_taken']:20} | {s['cnt']}")

# Check if there are velocity alerts at all
print("\nVELOCITY ALERTS (last 7h from edge_calculations):")
vel = conn.execute("""
SELECT action, COUNT(*) as cnt
FROM edge_calculations WHERE ts > datetime('now', '-7 hours')
GROUP BY action ORDER BY cnt DESC
""").fetchall()
for v in vel:
    print(f"  {v['action']:20} | {v['cnt']}")

# Check what's being filtered and why - sample recent momentum skips
print("\nSAMPLE VELOCITY ALERTS (last 2h):")
alerts = conn.execute("""
SELECT ec.market_id, m.question, ec.action,
  ec.side, ec.market_odds, ec.reasoning
FROM edge_calculations ec
LEFT JOIN musk_markets m ON ec.market_id = m.market_id
WHERE ec.ts > datetime('now', '-2 hours') AND ec.action = 'velocity_alert'
ORDER BY ec.ts DESC LIMIT 15
""").fetchall()
for a in alerts:
    print(f"  {a['action']:16} | {a['market_odds']:.0%} | {a['side'] or '':3} | {(a['question'] or a['market_id'])[:55]}")
    if a['reasoning']:
        print(f"                   | {a['reasoning'][:80]}")

# Check current open positions
print("\nOPEN POSITIONS:")
opens = conn.execute("SELECT COUNT(*) as c FROM predictions WHERE status = 'open'").fetchone()
print(f"  {opens['c']} open positions")

# When did all positions close?
last_close = conn.execute("""
SELECT id, side, question, pnl, status,
  COALESCE(closed_at, resolved_at) as closed
FROM predictions WHERE status != 'open'
ORDER BY COALESCE(closed_at, resolved_at) DESC LIMIT 5
""").fetchall()
print("\nLAST 5 CLOSED:")
for p in last_close:
    print(f"  [{p['id']}] {p['status']:6} | {p['side']:3} | P&L ${p['pnl'] or 0:+.2f} | {(p['closed'] or '?')[:16]} | {p['question'][:50]}")

conn.close()
