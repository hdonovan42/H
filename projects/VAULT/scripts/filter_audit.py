"""Audit specific filters for bugs — especially low_entry_odds and span check."""
import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# 1. Historical win rate by entry price — was the 50% cutoff justified?
print("=== WIN RATE BY ENTRY PRICE BUCKET ===")
print("(All historical data — remember ALL velocities were broken pre-v16.9)")
rows = conn.execute("""
    SELECT
        CASE
            WHEN entry_odds < 0.50 THEN '<50%'
            WHEN entry_odds < 0.60 THEN '50-60%'
            WHEN entry_odds < 0.70 THEN '60-70%'
            WHEN entry_odds < 0.80 THEN '70-80%'
            WHEN entry_odds < 0.90 THEN '80-90%'
            ELSE '90%+'
        END as bucket,
        COUNT(*) as n,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        ROUND(SUM(pnl), 4) as pnl
    FROM predictions WHERE status = 'closed'
    GROUP BY bucket ORDER BY bucket
""").fetchall()
for r in rows:
    wr = r["wins"] / r["n"] * 100 if r["n"] else 0
    print(f"  {r['bucket']:>6}: {r['n']:>3} bets, {r['wins']}W ({wr:.0f}%), PnL ${r['pnl']:+.4f}")

# 2. What markets were blocked by low_entry_odds in last 24h?
print("\n=== LOW ENTRY ODDS BLOCKS (from journalctl, simulated) ===")
# Check: what velocity alerts had entry < 50%?
# We can't replay journalctl, but we can check: what markets currently have
# velocity + low entry that would be blocked
markets = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price, m.volume, m.liquidity, m.spread
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
""").fetchall()

low_entry_blocked = 0
for m in markets:
    mid = m["market_id"]
    yes = m["yes_price"] or 0
    h1 = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    if len(h1) < 2:
        continue
    t1 = datetime.fromisoformat(h1[0]["ts"].replace("Z", "+00:00"))
    t2 = datetime.fromisoformat(h1[-1]["ts"].replace("Z", "+00:00"))
    span = (t2 - t1).total_seconds() / 60
    if span < 30:
        continue
    v_1h = yes - h1[0]["yes_price"]
    if abs(v_1h) < 0.05:
        continue
    side = "YES" if v_1h > 0 else "NO"
    entry = yes if side == "YES" else (1 - yes)
    if entry < 0.50:
        low_entry_blocked += 1
        remaining = 1 - entry
        print(f"  {side} @ {entry:.0%} (remaining {remaining:.0%}) | v={v_1h:+.1%} | {m['question'][:55]}")

if low_entry_blocked == 0:
    print("  None right now")

# 3. The 50% filter logic check — look at the ACTUAL code reasoning
print("\n=== ENTRY PRICE DIRECTION LOGIC ===")
print("The filter blocks: YES bets when yes_price < 50%, NO bets when no_price < 50%")
print("This means:")
print("  - YES at 39%: blocked (you'd need 61% to happen for it NOT to happen... wait)")
print("  - If market is at YES 39% and moving UP, we bet YES at 39% entry")
print("    That's 61% upside if YES resolves, 39% downside if NO resolves")
print("    Filter says: too risky, sub-50% momentum entries lose")
print("  - If market is at YES 61% and moving DOWN, we bet NO at 39% entry")
print("    Same 61% upside / 39% downside, also blocked")
print("")
print("  Q: Is this filter punishing the DIRECTION of the bet rather than the quality?")
print("  A market moving from 30%→40% has strong momentum but low entry price.")
print("  A market at 70% moving down to 60% has the same momentum but high entry (NO at 40%).")
print("  Both are blocked by the <50% filter.")

# 4. How many markets in the 40-50% range have had velocity alerts?
print("\n=== VELOCITY ALERTS IN 40-50% RANGE (from DB — approx) ===")
borderline = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND ((m.yes_price >= 0.40 AND m.yes_price < 0.50) OR (m.yes_price > 0.50 AND m.yes_price <= 0.60))
    ORDER BY m.volume DESC
""").fetchall()
print(f"  Markets currently in 40-60% band (where momentum could go either way): {len(borderline)}")
for m in borderline[:10]:
    print(f"    YES {m['yes_price']:.0%} | {m['question'][:60]}")

# 5. Check snapshot cadence — how often are we recording?
print("\n=== SNAPSHOT CADENCE (last 2 hours) ===")
cadence = conn.execute("""
    SELECT market_id, COUNT(*) as cnt,
           MIN(ts) as first_ts, MAX(ts) as last_ts
    FROM odds_snapshots
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')
    GROUP BY market_id
    ORDER BY cnt DESC
    LIMIT 5
""").fetchall()
for r in cadence:
    ft = r["first_ts"][:16] if r["first_ts"] else "?"
    lt = r["last_ts"][:16] if r["last_ts"] else "?"
    print(f"  {r['cnt']:>3} snaps | {ft} → {lt} | market {r['market_id']}")

# Show the cadence for one market
if cadence:
    sample_mid = cadence[0]["market_id"]
    snaps = conn.execute("""
        SELECT ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')
        ORDER BY ts ASC
    """, (sample_mid,)).fetchall()
    if len(snaps) >= 3:
        gaps = []
        for i in range(1, min(10, len(snaps))):
            t1 = datetime.fromisoformat(snaps[i-1]["ts"].replace("Z", "+00:00"))
            t2 = datetime.fromisoformat(snaps[i]["ts"].replace("Z", "+00:00"))
            gaps.append((t2 - t1).total_seconds())
        avg_gap = sum(gaps) / len(gaps)
        print(f"  Sample market {sample_mid}: avg gap = {avg_gap:.0f}s between snapshots")

# 6. The REAL question: what moved significantly in the last 6h that we DIDN'T bet on?
print("\n=== MISSED OPPORTUNITIES (6h lookback) ===")
print("Markets with > 10% total swing in 6h that we didn't bet on:")
all_mids = conn.execute("""
    SELECT DISTINCT market_id FROM odds_snapshots
    WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
""").fetchall()

missed = []
for row in all_mids:
    mid = row["market_id"]
    snaps = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    if len(snaps) < 5:
        continue
    prices = [s["yes_price"] for s in snaps]
    swing = max(prices) - min(prices)
    if swing < 0.10:
        continue

    # Check if we bet on this
    bet = conn.execute("""
        SELECT id FROM predictions WHERE market_id = ?
        AND opened_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
    """, (mid,)).fetchone()

    mkt = conn.execute("SELECT question, yes_price, liquidity, spread FROM musk_markets WHERE market_id = ?", (mid,)).fetchone()
    q = mkt["question"][:50] if mkt else mid
    liq = mkt["liquidity"] or 0 if mkt else 0
    spr = mkt["spread"] or 0 if mkt else 0

    status = "BET" if bet else "MISSED"
    missed.append((swing, q, prices[0], prices[-1], len(snaps), status, liq, spr))

missed.sort(key=lambda x: -x[0])
for swing, q, first, last, n, status, liq, spr in missed[:15]:
    net = last - first
    print(f"  [{status:>6}] swing={swing:.0%} net={net:+.1%} | {first:.0%}→{last:.0%} | {n} snaps | liq=${liq:,.0f} spr={spr:.0%} | {q}")

conn.close()
