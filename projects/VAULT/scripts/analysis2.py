import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# API costs - find right column name
cols = conn.execute("PRAGMA table_info(api_calls)").fetchall()
print("api_calls columns:", [c["name"] for c in cols])

# Gap between bets
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
    sgaps = sorted(gaps)
    print(f"  Median gap: {sgaps[len(sgaps)//2]:.1f}h")
    print(f"  Mean gap: {sum(gaps)/len(gaps):.1f}h")
    print(f"  Max gap: {max(gaps):.1f}h")
    print(f"  Min gap: {min(gaps):.2f}h")
    long_gaps = [g for g in gaps if g > 12]
    print(f"  Gaps > 12h: {len(long_gaps)} of {len(gaps)}")

last_bet = conn.execute("SELECT MAX(opened_at) as t FROM predictions").fetchone()["t"]
if last_bet:
    lb = datetime.fromisoformat(last_bet.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    hours_since = (now - lb).total_seconds() / 3600
    print(f"  Last bet: {last_bet[:19]} ({hours_since:.1f}h ago)")

# Check the ETH $1900 market - has big move
print("\n=== ETH $1900 MARKET (big mover) ===")
eth = conn.execute("""
    SELECT market_id, question, yes_price, volume, liquidity, spread
    FROM musk_markets WHERE question LIKE '%Ethereum%1,900%'
""").fetchone()
if eth:
    mid = eth["market_id"]
    print(f"  {eth['question']}")
    print(f"  YES: {eth['yes_price']:.0%}, vol: ${eth['volume']:,.0f}, liq: ${eth['liquidity']:,.0f}, spread: {eth['spread']:.0%}")
    snaps = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    if snaps:
        print(f"  6h history: {len(snaps)} snapshots")
        print(f"    First: {snaps[0]['ts'][:16]} YES={snaps[0]['yes_price']:.0%}")
        print(f"    Last:  {snaps[-1]['ts'][:16]} YES={snaps[-1]['yes_price']:.0%}")
        print(f"    Move: {snaps[-1]['yes_price'] - snaps[0]['yes_price']:+.1%}")

# BTC $64k market too
print("\n=== BTC $64K MARKET ===")
btc = conn.execute("""
    SELECT market_id, question, yes_price, volume, liquidity, spread
    FROM musk_markets WHERE question LIKE '%Bitcoin%64,000%'
""").fetchone()
if btc:
    mid = btc["market_id"]
    print(f"  {btc['question']}")
    print(f"  YES: {btc['yes_price']:.0%}, vol: ${btc['volume']:,.0f}, liq: ${btc['liquidity']:,.0f}, spread: {btc['spread']:.0%}")
    snaps = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    if snaps:
        print(f"  6h history: {len(snaps)} snapshots")
        print(f"    First: {snaps[0]['ts'][:16]} YES={snaps[0]['yes_price']:.0%}")
        print(f"    Last:  {snaps[-1]['ts'][:16]} YES={snaps[-1]['yes_price']:.0%}")
        print(f"    Move: {snaps[-1]['yes_price'] - snaps[0]['yes_price']:+.1%}")

# What does the velocity filter actually see right now?
print("\n=== WHAT VELOCITY CALC RETURNS (simulated) ===")
markets = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND m.yes_price >= 0.05 AND m.yes_price <= 0.95
    ORDER BY m.volume DESC LIMIT 30
""").fetchall()
for m in markets:
    mid = m["market_id"]
    h1 = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    h6 = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()

    v1 = None
    v6 = None
    if len(h1) >= 2:
        t1 = datetime.fromisoformat(h1[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(h1[-1]["ts"].replace("Z", "+00:00"))
        span = (t2 - t1).total_seconds() / 60
        if span >= 30:
            v1 = m["yes_price"] - h1[0]["yes_price"]
    if len(h6) >= 2:
        t1 = datetime.fromisoformat(h6[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(h6[-1]["ts"].replace("Z", "+00:00"))
        span = (t2 - t1).total_seconds() / 60
        if span >= 180:
            v6 = m["yes_price"] - h6[0]["yes_price"]

    if v1 is not None or v6 is not None:
        v1s = f"{v1:+.1%}" if v1 is not None else "n/a"
        v6s = f"{v6:+.1%}" if v6 is not None else "n/a"
        q = m["question"][:50]
        print(f"  v1h={v1s:>6} v6h={v6s:>6} | YES {m['yes_price']:.0%} | {q}")

# What about the pre-velocity-fix era? How often did it bet?
print("\n=== BETTING RATE COMPARISON ===")
# Before v16.9 (broken velocity) - first 6 days
pre = conn.execute("""
    SELECT COUNT(*) as n FROM predictions
    WHERE opened_at < '2026-02-18T21:30:00Z'
""").fetchone()["n"]
# After v16.9 (fixed velocity)
post = conn.execute("""
    SELECT COUNT(*) as n FROM predictions
    WHERE opened_at >= '2026-02-18T21:30:00Z'
""").fetchone()["n"]
print(f"  Pre-fix (6 days): {pre} bets ({pre/6:.1f}/day)")
print(f"  Post-fix (~16h):  {post} bets")

conn.close()
