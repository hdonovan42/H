import sqlite3
from datetime import datetime, timezone, timedelta

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# 1. Bet frequency over time
print("=== BET FREQUENCY BY DAY ===")
rows = conn.execute("""
    SELECT date(opened_at) as day, COUNT(*) as bets,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
           ROUND(SUM(pnl), 4) as day_pnl
    FROM predictions WHERE status = 'closed'
    GROUP BY day ORDER BY day
""").fetchall()
for r in rows:
    wr = r["wins"] / r["bets"] * 100 if r["bets"] else 0
    print(f"  {r['day']} | {r['bets']:3} bets | {r['wins']}W/{r['losses']}L ({wr:.0f}%) | PnL ${r['day_pnl']:+.4f}")

# 2. Overall stats
print("\n=== OVERALL ===")
total = conn.execute("""
    SELECT COUNT(*) as n,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
           ROUND(SUM(pnl), 4) as total_pnl,
           ROUND(AVG(pnl), 4) as avg_pnl,
           ROUND(AVG(CASE WHEN pnl > 0 THEN pnl END), 4) as avg_win,
           ROUND(AVG(CASE WHEN pnl <= 0 THEN pnl END), 4) as avg_loss,
           ROUND(SUM(cost_basis), 2) as total_wagered
    FROM predictions WHERE status = 'closed'
""").fetchone()
print(f"  Total bets: {total['n']}")
print(f"  Win rate: {total['wins']}/{total['n']} = {total['wins']/total['n']*100:.1f}%")
print(f"  Total PnL: ${total['total_pnl']}")
print(f"  Avg win: ${total['avg_win']}, Avg loss: ${total['avg_loss']}")
print(f"  Total wagered: ${total['total_wagered']}")

# 3. Open positions
print("\n=== OPEN POSITIONS ===")
opens = conn.execute("SELECT * FROM predictions WHERE status = 'open'").fetchall()
if opens:
    for r in opens:
        print(f"  {r['question'][:60]} | {r['side']} ${r['cost_basis']:.2f} @ {r['entry_odds']:.0%}")
else:
    print("  None")

# 4. What kinds of bets have we been making?
print("\n=== BET SIDE BREAKDOWN ===")
sides = conn.execute("""
    SELECT side, COUNT(*) as n,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           ROUND(SUM(pnl), 4) as pnl
    FROM predictions WHERE status = 'closed'
    GROUP BY side
""").fetchall()
for r in sides:
    wr = r["wins"] / r["n"] * 100 if r["n"] else 0
    print(f"  {r['side']}: {r['n']} bets, {r['wins']}W ({wr:.0f}%), PnL ${r['pnl']}")

# 5. What's being filtered right now? Check tracked markets
print("\n=== TOP TRACKED MARKETS (by volume, updated recently) ===")
markets = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price, m.volume, m.volume_24h,
           m.liquidity, m.spread, m.game_start_time, m.event_title,
           (SELECT COUNT(*) FROM odds_snapshots o
            WHERE o.market_id = m.market_id
            AND o.ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')) as snap_count_2h,
           (SELECT yes_price FROM odds_snapshots o
            WHERE o.market_id = m.market_id
            AND o.ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')
            ORDER BY o.ts ASC LIMIT 1) as price_2h_ago
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    ORDER BY m.volume DESC
    LIMIT 25
""").fetchall()
for r in markets:
    q = r["question"][:55] if r["question"] else "?"
    v_2h = ""
    if r["price_2h_ago"] and r["yes_price"]:
        delta = r["yes_price"] - r["price_2h_ago"]
        v_2h = f"  d2h={delta:+.1%}"
    spread = r["spread"] or 0
    liq = r["liquidity"] or 0
    yes = r["yes_price"] or 0
    print(f"  YES {yes:.0%} | vol ${r['volume']:>10,} | liq ${liq:>8,.0f} | spr {spread:.0%}{v_2h} | {q}")

# 6. How many markets pass basic filters?
print("\n=== FILTER FUNNEL (current tracked markets) ===")
all_tracked = conn.execute("""
    SELECT COUNT(*) FROM musk_markets
    WHERE last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
""").fetchone()[0]
not_extreme = conn.execute("""
    SELECT COUNT(*) FROM musk_markets
    WHERE last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND yes_price >= 0.05 AND yes_price <= 0.95
""").fetchone()[0]
good_spread = conn.execute("""
    SELECT COUNT(*) FROM musk_markets
    WHERE last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND yes_price >= 0.05 AND yes_price <= 0.95
    AND (spread IS NULL OR spread <= 0.10)
""").fetchone()[0]
good_liq = conn.execute("""
    SELECT COUNT(*) FROM musk_markets
    WHERE last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND yes_price >= 0.05 AND yes_price <= 0.95
    AND (spread IS NULL OR spread <= 0.10)
    AND (liquidity IS NULL OR liquidity >= 50)
""").fetchone()[0]
print(f"  Tracked (updated <1h):     {all_tracked}")
print(f"  Not extreme (5%-95%):      {not_extreme}")
print(f"  Good spread (<=10%):       {good_spread}")
print(f"  Good liquidity (>=$50):    {good_liq}")

# 7. API costs today
print("\n=== API COSTS (last 24h) ===")
costs = conn.execute("""
    SELECT purpose, COUNT(*) as calls, ROUND(SUM(cost), 4) as total_cost
    FROM api_calls
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY purpose ORDER BY total_cost DESC
""").fetchall()
for r in costs:
    print(f"  {r['purpose']}: {r['calls']} calls, ${r['total_cost']}")

# 8. How long between bets historically?
print("\n=== GAP BETWEEN BETS ===")
bet_times = conn.execute("""
    SELECT opened_at FROM predictions ORDER BY opened_at
""").fetchall()
gaps = []
for i in range(1, len(bet_times)):
    t1 = datetime.fromisoformat(bet_times[i-1]["opened_at"].replace("Z", "+00:00"))
    t2 = datetime.fromisoformat(bet_times[i]["opened_at"].replace("Z", "+00:00"))
    gap_h = (t2 - t1).total_seconds() / 3600
    gaps.append(gap_h)
if gaps:
    print(f"  Median gap: {sorted(gaps)[len(gaps)//2]:.1f}h")
    print(f"  Mean gap: {sum(gaps)/len(gaps):.1f}h")
    print(f"  Max gap: {max(gaps):.1f}h")
    print(f"  Min gap: {min(gaps):.2f}h")
    # How many gaps > 12h?
    long_gaps = [g for g in gaps if g > 12]
    print(f"  Gaps > 12h: {len(long_gaps)} of {len(gaps)}")

# 9. Time since last bet
last_bet = conn.execute("SELECT MAX(opened_at) as t FROM predictions").fetchone()["t"]
if last_bet:
    lb = datetime.fromisoformat(last_bet.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    hours_since = (now - lb).total_seconds() / 3600
    print(f"  Last bet: {last_bet[:19]} ({hours_since:.1f}h ago)")

conn.close()
