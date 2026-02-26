"""Comprehensive trade data extraction for team audit."""
import sqlite3
import json

db = sqlite3.connect('/home/hq/vault/vault.db')
db.row_factory = sqlite3.Row

print('=== TRADE SUMMARY ===')
print(f'Total predictions: {db.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]}')
for s in ['open', 'closed']:
    print(f'{s}: {db.execute("SELECT COUNT(*) FROM predictions WHERE status=?", (s,)).fetchone()[0]}')

print()
print('=== RESOLUTION BREAKDOWN (closed trades) ===')
for r in db.execute('''SELECT COALESCE(resolution, "sold/exited") as res, COUNT(*) as cnt,
  ROUND(SUM(pnl),2) as total_pnl, ROUND(AVG(pnl),3) as avg_pnl,
  ROUND(SUM(cost_basis),2) as total_cost
  FROM predictions WHERE status="closed"
  GROUP BY resolution ORDER BY total_pnl''').fetchall():
    print(f'{r["res"]:15s} count={r["cnt"]} total_pnl={r["total_pnl"]} avg_pnl={r["avg_pnl"]} total_cost={r["total_cost"]}')

print()
print('=== TOP 15 WORST TRADES ===')
for r in db.execute('''SELECT id, side, SUBSTR(question,1,70) as q, ROUND(entry_odds,3) as entry,
  ROUND(pnl,2) as pnl, resolution, ROUND(cost_basis,2) as cost, ROUND(shares,2) as shares
  FROM predictions WHERE status="closed" ORDER BY pnl ASC LIMIT 15''').fetchall():
    print(f'#{r["id"]} {r["side"]} {r["q"]} entry={r["entry"]} pnl={r["pnl"]} res={r["resolution"]} cost={r["cost"]} shares={r["shares"]}')

print()
print('=== TOP 15 BEST TRADES ===')
for r in db.execute('''SELECT id, side, SUBSTR(question,1,70) as q, ROUND(entry_odds,3) as entry,
  ROUND(pnl,2) as pnl, resolution, ROUND(cost_basis,2) as cost, ROUND(shares,2) as shares
  FROM predictions WHERE status="closed" ORDER BY pnl DESC LIMIT 15''').fetchall():
    print(f'#{r["id"]} {r["side"]} {r["q"]} entry={r["entry"]} pnl={r["pnl"]} res={r["resolution"]} cost={r["cost"]} shares={r["shares"]}')

print()
print('=== PNL BY SIDE ===')
for r in db.execute('''SELECT side, COUNT(*) as trades, ROUND(SUM(pnl),2) as total_pnl,
  ROUND(AVG(pnl),3) as avg_pnl, ROUND(SUM(cost_basis),2) as total_cost
  FROM predictions WHERE status="closed" GROUP BY side''').fetchall():
    print(f'{r["side"]}: trades={r["trades"]} total_pnl={r["total_pnl"]} avg_pnl={r["avg_pnl"]} total_cost={r["total_cost"]}')

print()
print('=== ENTRY ODDS DISTRIBUTION ===')
for r in db.execute('''SELECT CASE
  WHEN entry_odds < 0.2 THEN "0-20pct"
  WHEN entry_odds < 0.4 THEN "20-40pct"
  WHEN entry_odds < 0.6 THEN "40-60pct"
  WHEN entry_odds < 0.8 THEN "60-80pct"
  ELSE "80-100pct"
  END as band, COUNT(*) as trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winners,
  SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losers,
  ROUND(SUM(pnl),2) as total_pnl, ROUND(AVG(pnl),3) as avg_pnl
  FROM predictions WHERE status="closed" GROUP BY band ORDER BY band''').fetchall():
    print(f'{r["band"]:10s} trades={r["trades"]} W={r["winners"]} L={r["losers"]} PnL={r["total_pnl"]} avg={r["avg_pnl"]}')

print()
print('=== HOLD REASON COUNTS (last 500 holds) ===')
rows = db.execute('SELECT reasoning FROM cycles WHERE action="hold" ORDER BY id DESC LIMIT 500').fetchall()
reasons = {}
for r in rows:
    key = (r[0] or 'unknown')[:80]
    reasons[key] = reasons.get(key, 0) + 1
for k, v in sorted(reasons.items(), key=lambda x: -x[1])[:15]:
    print(f'{v:4d}x {k}')

print()
print('=== BURNED MARKETS ===')
print(f'Total burned: {db.execute("SELECT COUNT(*) FROM musk_markets WHERE blacklisted=1").fetchone()[0]}')

print()
print('=== TRADE DURATION ===')
for r in db.execute('''SELECT CASE
  WHEN (julianday(closed_at)-julianday(opened_at))*24 < 1 THEN "lt1h"
  WHEN (julianday(closed_at)-julianday(opened_at))*24 < 6 THEN "1to6h"
  WHEN (julianday(closed_at)-julianday(opened_at))*24 < 24 THEN "6to24h"
  WHEN (julianday(closed_at)-julianday(opened_at))*24 < 72 THEN "1to3d"
  ELSE "3dplus"
  END as duration, COUNT(*) as trades,
  ROUND(SUM(pnl),2) as total_pnl, ROUND(AVG(pnl),3) as avg_pnl
  FROM predictions WHERE status="closed" AND closed_at IS NOT NULL
  GROUP BY duration ORDER BY duration''').fetchall():
    print(f'{r["duration"]:6s} trades={r["trades"]} total_pnl={r["total_pnl"]} avg_pnl={r["avg_pnl"]}')

print()
print('=== POSITION SIZE ANALYSIS ===')
for r in db.execute('''SELECT CASE
  WHEN cost_basis < 1 THEN "lt1"
  WHEN cost_basis < 2 THEN "1to2"
  WHEN cost_basis < 3 THEN "2to3"
  ELSE "3plus"
  END as size_band, COUNT(*) as trades,
  ROUND(SUM(pnl),2) as total_pnl, ROUND(AVG(pnl),3) as avg_pnl
  FROM predictions WHERE status="closed" GROUP BY size_band ORDER BY size_band''').fetchall():
    print(f'{r["size_band"]:6s} trades={r["trades"]} total_pnl={r["total_pnl"]} avg_pnl={r["avg_pnl"]}')

print()
print('=== ENTRY REASONING SAMPLES (worst 10 trades) ===')
for r in db.execute('''SELECT id, ROUND(pnl,2) as pnl, side, SUBSTR(question,1,50) as q,
  ROUND(entry_odds,3) as odds, ROUND(entry_edge,3) as edge, ROUND(entry_confidence,2) as conf,
  SUBSTR(entry_reasoning,1,120) as reason
  FROM predictions WHERE status="closed" ORDER BY pnl ASC LIMIT 10''').fetchall():
    print(f'#{r["id"]} pnl={r["pnl"]} {r["side"]} {r["q"]} odds={r["odds"]} edge={r["edge"]} conf={r["conf"]}')
    print(f'  reason: {r["reason"]}')

print()
print('=== ENTRY REASONING SAMPLES (best 10 trades) ===')
for r in db.execute('''SELECT id, ROUND(pnl,2) as pnl, side, SUBSTR(question,1,50) as q,
  ROUND(entry_odds,3) as odds, ROUND(entry_edge,3) as edge, ROUND(entry_confidence,2) as conf,
  SUBSTR(entry_reasoning,1,120) as reason
  FROM predictions WHERE status="closed" ORDER BY pnl DESC LIMIT 10''').fetchall():
    print(f'#{r["id"]} pnl={r["pnl"]} {r["side"]} {r["q"]} odds={r["odds"]} edge={r["edge"]} conf={r["conf"]}')
    print(f'  reason: {r["reason"]}')

print()
print('=== CYCLES SUMMARY ===')
for r in db.execute('''SELECT action, COUNT(*) as cnt FROM cycles GROUP BY action ORDER BY cnt DESC''').fetchall():
    print(f'{r["action"]}: {r["cnt"]}')

print()
print('=== LEDGER SUMMARY ===')
for r in db.execute('''SELECT type, COUNT(*) as cnt, ROUND(SUM(amount),2) as total
  FROM ledger GROUP BY type ORDER BY total''').fetchall():
    print(f'{r["type"]:20s} count={r["cnt"]} total={r["total"]}')

print()
print('=== CONFIG ===')
import yaml
try:
    with open('/home/hq/vault/config/default.yaml') as f:
        cfg = yaml.safe_load(f)
    print(json.dumps(cfg, indent=2, default=str))
except Exception as e:
    print(f'Could not read config: {e}')

print()
print('=== ALL CLOSED TRADES (pipe-delimited) ===')
print('id|side|question|entry_odds|cost_basis|shares|pnl|resolution|entry_edge|entry_confidence|peak_roi|opened_at|closed_at|entry_reasoning')
for r in db.execute('''SELECT id, side, question, ROUND(entry_odds,4), ROUND(cost_basis,3),
  ROUND(shares,3), ROUND(pnl,3), resolution, ROUND(entry_edge,4), ROUND(entry_confidence,3),
  ROUND(peak_roi,3), opened_at, closed_at, SUBSTR(entry_reasoning,1,200)
  FROM predictions WHERE status="closed" ORDER BY id''').fetchall():
    print('|'.join(str(x) for x in r))

print()
print('=== ODDS SNAPSHOTS (sample of recent) ===')
try:
    for r in db.execute('''SELECT market_id, ROUND(yes_price,3) as yes, ROUND(no_price,3) as no,
      recorded_at FROM odds_snapshots ORDER BY id DESC LIMIT 30''').fetchall():
        print(f'{r["market_id"][:20]} yes={r["yes"]} no={r["no"]} at={r["recorded_at"]}')
except Exception as e:
    print(f'odds_snapshots error: {e}')

db.close()
