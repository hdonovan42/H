"""Full pipeline diagnostic: what's firing, what's being blocked, why."""
import sqlite3, sys
from datetime import datetime, timezone

conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row

now = datetime.now(timezone.utc)

# Latest cycles
print("=== LAST 10 CYCLES ===")
rows = conn.execute("SELECT id, ts_start, action, reasoning, total_cost, balance_after FROM cycles ORDER BY id DESC LIMIT 10").fetchall()
for r in rows:
    reason = (r["reasoning"] or "")[:120]
    cost = r["total_cost"] or 0
    print(f"  #{r['id']} | {r['ts_start']} | {r['action']:10s} | ${cost:.4f} | {reason}")

# Smart money log — all events in last 2 hours
print("\n=== SMART MONEY LOG (last 2h) ===")
sml = conn.execute("""
    SELECT ts, question, action_taken, side, market_odds, v_1h, v_6h, z_1h, confidence
    FROM smart_money_log
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')
    ORDER BY ts DESC
    LIMIT 30
""").fetchall()
if not sml:
    print("  (none)")
for s in sml:
    q = (s["question"] or "")[:50]
    v1h = s["v_1h"] or 0
    z = s["z_1h"] or 0
    conf = s["confidence"] or 0
    print(f"  {s['ts']} | {s['action_taken']:18s} | {s['side'] or '?':3s} @ {s['market_odds'] or 0:.2f} | v1h={v1h:+.1%} z={z:+.1f} conf={conf:.2f} | {q}")

# API calls in last 2 hours
print("\n=== API CALLS (last 2h) ===")
api = conn.execute("""
    SELECT ts, model, purpose, cost_usd
    FROM api_calls
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')
    ORDER BY ts DESC
    LIMIT 20
""").fetchall()
if not api:
    print("  (none)")
for a in api:
    print(f"  {a['ts']} | {a['purpose']:30s} | ${a['cost_usd']:.4f}")

# Markets with biggest moves right now
print("\n=== BIGGEST 1H MOVERS ===")
movers = conn.execute("""
    SELECT market_id,
           MIN(yes_price) as low,
           MAX(yes_price) as high,
           MAX(yes_price) - MIN(yes_price) as swing,
           COUNT(*) as snaps
    FROM odds_snapshots
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    GROUP BY market_id
    HAVING swing > 0.03
    ORDER BY swing DESC
    LIMIT 10
""").fetchall()
if movers:
    for m in movers:
        q_row = conn.execute("SELECT question FROM musk_markets WHERE market_id = ?", (m["market_id"],)).fetchone()
        q = (q_row["question"] if q_row else m["market_id"])[:55]
        print(f"  swing={m['swing']:+.1%} | {m['low']:.2f}→{m['high']:.2f} | {m['snaps']} snaps | {q}")
else:
    print("  (no markets with >3% swing)")

# Open predictions
print("\n=== OPEN PREDICTIONS ===")
preds = conn.execute("SELECT id, question, side, shares, entry_odds, cost_basis, opened_at FROM predictions WHERE status='open' ORDER BY opened_at DESC").fetchall()
if not preds:
    print("  (none)")
for p in preds:
    print(f"  [{p['id']}] {p['side']:3s} @ {p['entry_odds']:.2f} | ${p['cost_basis']:.2f} | {p['question'][:60]}")

# Stats
bal = conn.execute("SELECT balance, total_pnl, positions_value FROM objectives ORDER BY id DESC LIMIT 1").fetchone()
total_cycles = conn.execute("SELECT COUNT(*) FROM cycles").fetchone()[0]
bets_today = conn.execute("SELECT COUNT(*) FROM cycles WHERE action IN ('bet','buy') AND ts_start > '2026-02-19T00:00:00'").fetchone()[0]
haiku_today = conn.execute("SELECT COUNT(*), SUM(cost_usd) FROM api_calls WHERE purpose='momentum_validation' AND ts > '2026-02-19T00:00:00'").fetchone()
print(f"\n=== STATS ===")
print(f"  Balance: ${bal['balance']:.2f} | PnL: ${bal['total_pnl']:+.2f} | Positions: ${bal['positions_value']:.2f}")
print(f"  Total cycles: {total_cycles} | Bets today: {bets_today}")
print(f"  Haiku calls today: {haiku_today[0]} | Cost: ${haiku_today[1] or 0:.4f}")
