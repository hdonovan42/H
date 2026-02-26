"""Analyse side-switching impact across all momentum trades."""
import sqlite3

db = sqlite3.connect('/home/hq/vault/vault.db')

FILTER = "entry_reasoning LIKE 'Sharp move%' AND status='closed'"

# 1. Find all markets with both-side trades
print("=== ALL MARKETS WITH BOTH-SIDE TRADES (momentum only) ===\n")
both_side_markets = db.execute(f"""
    SELECT market_id, SUBSTR(question,1,60) as q,
      SUM(CASE WHEN side='YES' THEN 1 ELSE 0 END) as yes_cnt,
      SUM(CASE WHEN side='NO' THEN 1 ELSE 0 END) as no_cnt,
      ROUND(SUM(pnl),2) as total_pnl,
      ROUND(SUM(CASE WHEN side='YES' THEN pnl ELSE 0 END),2) as yes_pnl,
      ROUND(SUM(CASE WHEN side='NO' THEN pnl ELSE 0 END),2) as no_pnl,
      ROUND(SUM(cost_basis),2) as total_cost,
      COUNT(*) as total_trades
    FROM predictions WHERE {FILTER}
    GROUP BY market_id
    HAVING yes_cnt > 0 AND no_cnt > 0
    ORDER BY total_pnl ASC
""").fetchall()

for r in both_side_markets:
    print(f"{r[1]}")
    print(f"  YES={r[2]} ({r[5]:+.2f}) | NO={r[3]} ({r[6]:+.2f}) | NET={r[4]:+.2f} | cost={r[7]} | trades={r[8]}")
    print()

# Totals
total_markets = len(both_side_markets)
total_trades = sum(r[8] for r in both_side_markets)
total_pnl = sum(r[4] for r in both_side_markets)
total_cost = sum(r[7] for r in both_side_markets)
print(f"=== TOTALS ===")
print(f"Both-side markets: {total_markets} | Total trades: {total_trades} | Net PnL: ${total_pnl:.2f} | Cost: ${total_cost:.2f}")

# 2. What-if: only keep the first side entered per market
print("\n=== WHAT-IF: BLOCK SIDE-SWITCHES (keep only first side per market) ===\n")

kept_pnl_total = 0
blocked_pnl_total = 0

for mkt in both_side_markets:
    market_id = mkt[0]
    q = mkt[1]

    # Get the first trade's side for this market
    first = db.execute(f"""
        SELECT side FROM predictions
        WHERE market_id=? AND {FILTER}
        ORDER BY id ASC LIMIT 1
    """, (market_id,)).fetchone()
    first_side = first[0]

    # Get PnL for kept side vs blocked side
    kept = db.execute(f"""
        SELECT COUNT(*), ROUND(SUM(pnl),2), ROUND(SUM(cost_basis),2)
        FROM predictions WHERE market_id=? AND side=? AND {FILTER}
    """, (market_id, first_side)).fetchone()

    blocked = db.execute(f"""
        SELECT COUNT(*), ROUND(SUM(pnl),2), ROUND(SUM(cost_basis),2)
        FROM predictions WHERE market_id=? AND side!=? AND {FILTER}
    """, (market_id, first_side)).fetchone()

    kept_pnl = kept[1] or 0
    blocked_pnl = blocked[1] or 0
    kept_pnl_total += kept_pnl
    blocked_pnl_total += blocked_pnl

    marker = "HELPED" if blocked_pnl < 0 else "HURT"
    print(f"{q}")
    print(f"  First: {first_side} | Kept: {kept[0]}t {kept_pnl:+.2f} (${kept[2]}) | Blocked: {blocked[0]}t {blocked_pnl:+.2f} (${blocked[2]}) | [{marker}]")
    print()

print(f"=== WHAT-IF SUMMARY ===")
print(f"PnL from first-side trades (kept):    ${kept_pnl_total:+.2f}")
print(f"PnL from side-switch trades (blocked): ${blocked_pnl_total:+.2f}")
print(f"Actual total:                          ${kept_pnl_total + blocked_pnl_total:+.2f}")
print(f"Counterfactual (no side-switches):     ${kept_pnl_total:+.2f}")
print(f"Net benefit of blocking switches:      ${-blocked_pnl_total:+.2f}")

# 3. Same analysis but also for single-side markets (control group)
print("\n=== CONTROL: SINGLE-SIDE MARKETS ===")
single = db.execute(f"""
    SELECT COUNT(DISTINCT market_id) as markets, COUNT(*) as trades,
      ROUND(SUM(pnl),2) as pnl, ROUND(SUM(cost_basis),2) as cost
    FROM predictions WHERE {FILTER}
    AND market_id NOT IN (
      SELECT market_id FROM predictions WHERE {FILTER}
      GROUP BY market_id
      HAVING SUM(CASE WHEN side='YES' THEN 1 ELSE 0 END) > 0
         AND SUM(CASE WHEN side='NO' THEN 1 ELSE 0 END) > 0
    )
""").fetchone()
print(f"Single-side markets: {single[0]} | Trades: {single[1]} | PnL: ${single[2]} | Cost: ${single[3]}")
print(f"Avg PnL/trade: ${single[2]/single[1]:.3f}" if single[1] else "N/A")

both = db.execute(f"""
    SELECT COUNT(*) as trades, ROUND(SUM(pnl),2) as pnl
    FROM predictions WHERE {FILTER}
    AND market_id IN (
      SELECT market_id FROM predictions WHERE {FILTER}
      GROUP BY market_id
      HAVING SUM(CASE WHEN side='YES' THEN 1 ELSE 0 END) > 0
         AND SUM(CASE WHEN side='NO' THEN 1 ELSE 0 END) > 0
    )
""").fetchone()
print(f"\nBoth-side markets: {total_markets} | Trades: {both[0]} | PnL: ${both[1]}")
print(f"Avg PnL/trade: ${both[1]/both[0]:.3f}" if both[0] else "N/A")

db.close()
