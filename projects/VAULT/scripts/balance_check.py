import sqlite3
conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

first = conn.execute("SELECT ts FROM api_calls ORDER BY ts ASC LIMIT 1").fetchone()
last = conn.execute("SELECT ts FROM api_calls ORDER BY ts DESC LIMIT 1").fetchone()
print(f"First API call: {first['ts'] if first else 'none'}")
print(f"Last API call:  {last['ts'] if last else 'none'}")

total_cycles = conn.execute("SELECT COUNT(*) as c FROM cycles").fetchone()["c"]
print(f"Total cycles: {total_cycles}")

preds = conn.execute("""
SELECT status, COUNT(*) as cnt, ROUND(COALESCE(SUM(pnl), 0), 2) as pnl
FROM predictions GROUP BY status
""").fetchall()
print("\nPredictions:")
for r in preds:
    print(f"  {r['status']:10} | count: {r['cnt']:4} | P&L: {r['pnl']}")

open_count = conn.execute("SELECT COUNT(*) as c FROM predictions WHERE status = 'open'").fetchone()["c"]
print(f"\nOpen positions: {open_count}")

open_preds = conn.execute("""
SELECT side, question, cost_basis, shares, entry_odds, opened_at
FROM predictions WHERE status = 'open' ORDER BY opened_at DESC LIMIT 5
""").fetchall()
for p in open_preds:
    print(f"  {p['side']:3} | cost:{p['cost_basis']:.2f} | {p['entry_odds']:.0%} | {p['question'][:55]}")

pnl = conn.execute("SELECT ROUND(COALESCE(SUM(pnl), 0), 2) as p FROM predictions WHERE pnl IS NOT NULL").fetchone()["p"]
print(f"\nTotal realized P&L: {pnl}")

seed = conn.execute("SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE entry_type = 'seed'").fetchone()[0]
api = conn.execute("SELECT COALESCE(SUM(ABS(amount)), 0) FROM ledger WHERE entry_type = 'api_cost'").fetchone()[0]
trade = conn.execute("SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE entry_type IN ('trade_pnl', 'prediction_pnl')").fetchone()[0]
print(f"\nBalance breakdown:")
print(f"  Seed:      {seed:.2f}")
print(f"  API costs: -{api:.2f}")
print(f"  Trade P&L: {trade:+.2f}")
print(f"  Balance:   {seed - api + trade:.2f}")

conn.close()
