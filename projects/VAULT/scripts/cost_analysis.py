"""One-off cost analysis script for Haiku vs Sonnet comparison."""
import sqlite3

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# API costs by model and high-level purpose
rows = conn.execute("""
SELECT model,
  CASE
    WHEN purpose LIKE 'cycle_%' THEN 'legacy_tool_loop'
    ELSE purpose
  END as purpose_group,
  COUNT(*) as calls,
  SUM(input_tokens) as total_in, SUM(output_tokens) as total_out,
  ROUND(AVG(input_tokens)) as avg_in, ROUND(AVG(output_tokens)) as avg_out,
  ROUND(SUM(cost_usd), 4) as total_cost,
  ROUND(AVG(cost_usd), 6) as avg_cost_per_call
FROM api_calls
GROUP BY model, purpose_group
ORDER BY total_cost DESC
""").fetchall()

print("MODEL     | PURPOSE                         | CALLS | AVG_IN  | AVG_OUT | TOTAL_COST | AVG/CALL")
print("-" * 110)
for r in rows:
    short = r["model"].split("-")[1] if "-" in r["model"] else r["model"]
    print(f'{short:9} | {r["purpose_group"]:31} | {r["calls"]:5} | {r["avg_in"]:7.0f} | {r["avg_out"]:7.0f} | ${r["total_cost"]:8.4f} | ${r["avg_cost_per_call"]:.6f}')

# Total costs
total = conn.execute("SELECT ROUND(SUM(cost_usd), 4) FROM api_calls").fetchone()[0]
print(f"\nTOTAL API COST: ${total}")

# Balance from ledger
bal_row = conn.execute("SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1").fetchone()
bal = bal_row["balance_after"] if bal_row else 0
print(f"BALANCE: ${bal:.2f}")

# Last 7 days costs
recent = conn.execute("""SELECT ROUND(SUM(cost_usd), 4), COUNT(*) FROM api_calls
  WHERE ts > datetime('now', '-7 days')""").fetchone()
print(f"LAST 7d: ${recent[0] or 0} over {recent[1]} calls")

# Cycles per day (last 7 days)
cpd = conn.execute("""SELECT ROUND(COUNT(*) / 7.0, 1) FROM cycles
  WHERE ts_start > datetime('now', '-7 days')""").fetchone()[0]
print(f"CYCLES/DAY (7d avg): {cpd}")

# Haiku -> Sonnet projection
print("\n" + "=" * 80)
print("HAIKU -> SONNET COST PROJECTION (all time)")
print("=" * 80)

haiku_calls = conn.execute("""
SELECT
  CASE WHEN purpose LIKE 'cycle_%' THEN 'legacy_tool_loop' ELSE purpose END as purpose_group,
  COUNT(*) as calls,
  SUM(input_tokens) as total_in, SUM(output_tokens) as total_out,
  ROUND(SUM(cost_usd), 4) as haiku_cost
FROM api_calls
WHERE model LIKE '%haiku%'
GROUP BY purpose_group
ORDER BY haiku_cost DESC
""").fetchall()

total_haiku = 0
total_sonnet_projected = 0
for r in haiku_calls:
    haiku_cost = r["haiku_cost"]
    sonnet_cost = round((r["total_in"] * 3.0 / 1_000_000) + (r["total_out"] * 15.0 / 1_000_000), 4)
    multiplier = sonnet_cost / haiku_cost if haiku_cost > 0 else 0
    total_haiku += haiku_cost
    total_sonnet_projected += sonnet_cost
    print(f"{r['purpose_group']:35} | Haiku: ${haiku_cost:8.4f} | Sonnet: ${sonnet_cost:8.4f} | {multiplier:.1f}x")

print(f"\n{'TOTAL':35} | Haiku: ${total_haiku:8.4f} | Sonnet: ${total_sonnet_projected:8.4f} | {total_sonnet_projected/total_haiku:.1f}x")

# Last 7 days projection
haiku_7d = conn.execute("""
SELECT SUM(input_tokens) as total_in, SUM(output_tokens) as total_out,
  ROUND(SUM(cost_usd), 4) as haiku_cost, COUNT(*) as calls
FROM api_calls
WHERE model LIKE '%haiku%' AND ts > datetime('now', '-7 days')
""").fetchone()

all_7d = conn.execute("""
SELECT ROUND(SUM(cost_usd), 4) as total_cost
FROM api_calls WHERE ts > datetime('now', '-7 days')
""").fetchone()

if haiku_7d and haiku_7d["haiku_cost"]:
    sonnet_7d = round((haiku_7d["total_in"] * 3.0 / 1_000_000) + (haiku_7d["total_out"] * 15.0 / 1_000_000), 4)
    non_haiku_7d = (all_7d["total_cost"] or 0) - haiku_7d["haiku_cost"]
    daily_total_haiku = (non_haiku_7d + haiku_7d["haiku_cost"]) / 7
    daily_total_sonnet = (non_haiku_7d + sonnet_7d) / 7
    print(f"\nLAST 7 DAYS ({haiku_7d['calls']} Haiku calls):")
    print(f"  Haiku portion:  ${haiku_7d['haiku_cost']:.4f} (${haiku_7d['haiku_cost']/7:.4f}/day)")
    print(f"  Sonnet equiv:   ${sonnet_7d:.4f} (${sonnet_7d/7:.4f}/day)")
    print(f"  Non-Haiku (Opus etc): ${non_haiku_7d:.4f}")
    print(f"  Total daily (current):  ${daily_total_haiku:.4f}/day")
    print(f"  Total daily (w/Sonnet): ${daily_total_sonnet:.4f}/day")

    if bal > 0:
        runway_current = bal / daily_total_haiku if daily_total_haiku > 0 else float('inf')
        runway_sonnet = bal / daily_total_sonnet if daily_total_sonnet > 0 else float('inf')
        print(f"\n  Runway (current):  {runway_current:.0f} days ({runway_current/365:.1f} years)")
        print(f"  Runway (w/Sonnet): {runway_sonnet:.0f} days ({runway_sonnet/365:.1f} years)")
        print(f"  Runway lost:       {runway_current - runway_sonnet:.0f} days")

# Win rate analysis
print("\n" + "=" * 80)
print("TRADING PERFORMANCE")
print("=" * 80)
preds = conn.execute("""
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
  ROUND(SUM(pnl), 2) as total_pnl,
  ROUND(AVG(pnl), 4) as avg_pnl
FROM predictions WHERE status IN ('won', 'lost', 'sold')
""").fetchone()

if preds and preds["total"] > 0:
    wr = preds["wins"] / preds["total"] * 100
    print(f"Total trades: {preds['total']} | Wins: {preds['wins']} | Losses: {preds['losses']} | Win rate: {wr:.1f}%")
    print(f"Total P&L: ${preds['total_pnl']} | Avg P&L/trade: ${preds['avg_pnl']}")

# Momentum vs pipeline
mom = conn.execute("""
SELECT
  CASE WHEN entry_reasoning LIKE 'Momentum%' THEN 'momentum' ELSE 'pipeline' END as source,
  COUNT(*) as total,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(SUM(pnl), 2) as total_pnl,
  ROUND(AVG(pnl), 4) as avg_pnl
FROM predictions WHERE status IN ('won', 'lost', 'sold')
GROUP BY source
""").fetchall()

print("\nBy source:")
for r in mom:
    wr = r["wins"] / r["total"] * 100 if r["total"] > 0 else 0
    print(f"  {r['source']:12} | Trades: {r['total']:4} | Wins: {r['wins']:4} | WR: {wr:5.1f}% | P&L: ${r['total_pnl']:8.2f} | Avg: ${r['avg_pnl']:.4f}")

# Current 7d Haiku usage detail
print("\n" + "=" * 80)
print("CURRENT HAIKU USAGE (last 7 days only)")
print("=" * 80)
recent_haiku = conn.execute("""
SELECT
  CASE WHEN purpose LIKE 'cycle_%' THEN 'legacy_tool_loop' ELSE purpose END as pg,
  COUNT(*) as calls,
  ROUND(AVG(input_tokens)) as avg_in, ROUND(AVG(output_tokens)) as avg_out,
  ROUND(SUM(cost_usd), 4) as total_cost
FROM api_calls
WHERE model LIKE '%haiku%' AND ts > datetime('now', '-7 days')
GROUP BY pg
ORDER BY total_cost DESC
""").fetchall()

for r in recent_haiku:
    sonnet_cost = round((r["avg_in"] * r["calls"] * 3.0 / 1_000_000 + r["avg_out"] * r["calls"] * 15.0 / 1_000_000), 4)
    print(f"  {r['pg']:30} | {r['calls']:4} calls | avg {r['avg_in']:.0f}in/{r['avg_out']:.0f}out | H: ${r['total_cost']:.4f} | S: ${sonnet_cost:.4f}")

# Sonnet decider analysis (recently upgraded)
print("\n" + "=" * 80)
print("SONNET DECIDER USAGE (if any)")
print("=" * 80)
sonnet_calls = conn.execute("""
SELECT purpose, COUNT(*) as calls, ROUND(SUM(cost_usd), 4) as total_cost,
  ROUND(AVG(input_tokens)) as avg_in, ROUND(AVG(output_tokens)) as avg_out
FROM api_calls
WHERE model LIKE '%sonnet%'
GROUP BY purpose
ORDER BY total_cost DESC
""").fetchall()
if sonnet_calls:
    for r in sonnet_calls:
        print(f"  {r['purpose']:30} | {r['calls']:4} calls | avg {r['avg_in']:.0f}in/{r['avg_out']:.0f}out | ${r['total_cost']:.4f}")
else:
    print("  No Sonnet calls found")

conn.close()
