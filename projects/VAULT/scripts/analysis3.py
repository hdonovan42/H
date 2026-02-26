import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# What does the velocity calc actually see right now?
print("=== CURRENT VELOCITY SIGNALS (simulated) ===")
markets = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price, m.spread, m.liquidity
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND m.yes_price >= 0.05 AND m.yes_price <= 0.95
    ORDER BY m.volume DESC LIMIT 50
""").fetchall()

any_signal = False
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
    span1 = 0
    if len(h1) >= 2:
        t1 = datetime.fromisoformat(h1[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(h1[-1]["ts"].replace("Z", "+00:00"))
        span1 = (t2 - t1).total_seconds() / 60
        if span1 >= 30:
            v1 = m["yes_price"] - h1[0]["yes_price"]
    if len(h6) >= 2:
        t1 = datetime.fromisoformat(h6[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(h6[-1]["ts"].replace("Z", "+00:00"))
        span6 = (t2 - t1).total_seconds() / 60
        if span6 >= 180:
            v6 = m["yes_price"] - h6[0]["yes_price"]

    # Show anything with measurable velocity
    if v1 is not None and abs(v1) >= 0.01:
        any_signal = True
        v1s = f"{v1:+.1%}" if v1 is not None else "n/a"
        v6s = f"{v6:+.1%}" if v6 is not None else "n/a"
        q = m["question"][:55]
        spr = f"{m['spread']:.0%}" if m["spread"] else "?"
        liq = f"${m['liquidity']:,.0f}" if m["liquidity"] else "?"
        print(f"  v1h={v1s:>7} v6h={v6s:>7} | YES {m['yes_price']:.0%} | spr {spr} | liq {liq} | {q}")

if not any_signal:
    print("  No markets with |v_1h| >= 1% right now")

# Would-be-profitable bets we missed (check markets that moved significantly in last 24h)
print("\n=== BIG MOVERS LAST 24H (retrospective — what did we miss?) ===")
all_markets = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')
""").fetchall()

movers = []
for m in all_markets:
    mid = m["market_id"]
    snaps = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    if len(snaps) < 10:
        continue
    prices = [s["yes_price"] for s in snaps]
    max_move = max(prices) - min(prices)
    if max_move >= 0.10:  # 10%+ swing in 24h
        movers.append({
            "question": m["question"],
            "current": m["yes_price"],
            "low": min(prices),
            "high": max(prices),
            "swing": max_move,
            "first": prices[0],
            "last": prices[-1],
            "net": prices[-1] - prices[0],
            "snaps": len(snaps)
        })

movers.sort(key=lambda x: x["swing"], reverse=True)
for m in movers[:15]:
    q = m["question"][:50]
    print(f"  swing {m['swing']:+.0%} | {m['low']:.0%}-{m['high']:.0%} | net {m['net']:+.1%} | now {m['current']:.0%} | {q}")

# Betting rate comparison
print("\n=== BETTING RATE ===")
pre = conn.execute("SELECT COUNT(*) as n FROM predictions WHERE opened_at < '2026-02-18T21:30:00Z'").fetchone()["n"]
post = conn.execute("SELECT COUNT(*) as n FROM predictions WHERE opened_at >= '2026-02-18T21:30:00Z'").fetchone()["n"]
pre_days = 6.5  # roughly Feb 12-18 midday
print(f"  Pre-velocity-fix ({pre_days:.0f} days): {pre} bets ({pre/pre_days:.1f}/day)")
print(f"  Post-velocity-fix (~18h):  {post} bets")
print(f"  Current dry spell: 17.8h since last bet")

conn.close()
