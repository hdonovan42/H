"""Full pipeline audit — trace every market through every filter to find bugs."""
import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

now = datetime.now(timezone.utc)
print(f"=== PIPELINE AUDIT — {now.strftime('%Y-%m-%d %H:%M UTC')} ===\n")

# 1. How many markets are we tracking?
total_tracked = conn.execute(
    "SELECT COUNT(*) FROM musk_markets WHERE last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')"
).fetchone()[0]
total_all = conn.execute("SELECT COUNT(*) FROM musk_markets").fetchone()[0]
print(f"MARKET UNIVERSE: {total_tracked} tracked (updated <1h), {total_all} total in DB")

# 2. Snapshot coverage — are we actually recording snapshots?
snap_1h = conn.execute(
    "SELECT COUNT(DISTINCT market_id) FROM odds_snapshots WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')"
).fetchone()[0]
snap_6h = conn.execute(
    "SELECT COUNT(DISTINCT market_id) FROM odds_snapshots WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')"
).fetchone()[0]
print(f"SNAPSHOT COVERAGE: {snap_1h} markets with 1h snapshots, {snap_6h} with 6h snapshots")

# 3. For every tracked market, simulate the velocity calculation
print(f"\n{'='*100}")
print(f"VELOCITY SIMULATION — what does each market look like right now?")
print(f"{'='*100}")

markets = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price, m.volume, m.volume_24h,
           m.liquidity, m.spread, m.game_start_time, m.event_title, m.end_date
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    ORDER BY m.volume DESC
""").fetchall()

vel_cfg = {
    "momentum_min_velocity_1h": 0.10,
    "momentum_min_velocity_1h_sports": 0.05,
    "z_override_min_velocity": 0.07,
    "z_override_threshold": 4.0,
    "momentum_min_volume": 10000,
    "min_span_minutes_1h": 30,
    "min_span_minutes_6h": 180,
}

# Sports detection
def is_sports(q):
    q = q.lower()
    if " vs " in q or " vs. " in q:
        return True
    keywords = ["open:", "grand prix", "grand slam", "world cup",
                "nba", "nfl", "mlb", "nhl", "premier league", "la liga",
                "serie a", "bundesliga", "champions league", "europa league",
                "atp", "wta", "ufc", "bellator", "pga", "lpga",
                "counter-strike", "dota", "valorant", "league of legends"]
    return any(kw in q for kw in keywords)

# Noisy pattern detection
def is_noisy(q):
    q = q.lower()
    patterns = ["over/under", "o/u ", " o/u", "total points", "total goals",
                "total maps", "spread", "end in a draw", "draw or",
                "by at least", "margin"]
    return any(p in q for p in patterns)

candidates = []
blocked_summary = {}

for m in markets:
    mid = m["market_id"]
    q = m["question"] or ""
    yes = m["yes_price"] or 0
    vol = m["volume"] or 0
    liq = m["liquidity"] or 0
    spr = m["spread"] or 0

    # Get snapshots
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

    # Calculate velocity
    v_1h = None
    v_6h = None
    span_1h = 0
    span_6h = 0

    if len(h1) >= 2:
        t1 = datetime.fromisoformat(h1[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(h1[-1]["ts"].replace("Z", "+00:00"))
        span_1h = (t2 - t1).total_seconds() / 60
        if span_1h >= 30:
            v_1h = yes - h1[0]["yes_price"]

    if len(h6) >= 2:
        t1 = datetime.fromisoformat(h6[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(h6[-1]["ts"].replace("Z", "+00:00"))
        span_6h = (t2 - t1).total_seconds() / 60
        if span_6h >= 180:
            v_6h = yes - h6[0]["yes_price"]

    # Calculate z-score (simplified)
    h24 = conn.execute("""
        SELECT yes_price FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()

    z_1h = None
    if v_1h is not None and len(h24) >= 30:
        prices = [r["yes_price"] for r in h24]
        changes = [prices[i] - prices[i-1] for i in range(1, len(prices))]
        if changes:
            import statistics
            mean_c = statistics.mean(changes)
            std_c = statistics.stdev(changes) if len(changes) > 1 else 0
            if std_c > 0.001:
                z_1h = (v_1h - mean_c * (span_1h / (1440 / len(changes)))) / (std_c * (span_1h ** 0.5))

    # Now trace through filters
    sport = is_sports(q)
    noisy = is_noisy(q)

    # Would this trigger a velocity alert? (simplified — real code uses sharp_threshold)
    has_alert = False
    if v_1h is not None and abs(v_1h) >= 0.05:
        has_alert = True
    elif v_6h is not None and abs(v_6h) >= 0.10:
        has_alert = True

    if not has_alert:
        continue  # Not even alerting — skip

    # Now simulate each filter
    blocked_at = None
    reason = None

    # Filter 1: Noisy market type
    if noisy:
        blocked_at = "noisy_type"
        reason = f"noisy pattern in question"

    # Filter 2: Extreme entry
    side = "YES" if (v_1h or 0) > 0 else "NO"
    entry_price = yes if side == "YES" else (1 - yes)
    if not blocked_at and entry_price >= 0.995:
        blocked_at = "extreme_entry"
        reason = f"{side} @ {entry_price:.2%}"

    # Filter 3: Low entry odds (<50%)
    if not blocked_at and entry_price < 0.50:
        blocked_at = "low_entry"
        reason = f"{side} @ {entry_price:.2%}"

    # Filter 4: Wide spread
    if not blocked_at and spr > 0.10:
        blocked_at = "wide_spread"
        reason = f"spread {spr:.0%}"

    # Filter 5: Low liquidity
    if not blocked_at and liq > 0 and liq < 50:
        blocked_at = "low_liquidity"
        reason = f"liq ${liq:.0f}"

    # Filter 6: Velocity minimum
    min_vel = 0.05 if sport else 0.10
    abs_v = abs(v_1h) if v_1h is not None else 0
    if not blocked_at and v_1h is None:
        blocked_at = "no_v_1h"
        reason = f"span={span_1h:.0f}m < 30m min ({len(h1)} snaps)"
    elif not blocked_at and abs_v < min_vel:
        # Check z-gate
        z_passes = (not sport and z_1h is not None and abs(z_1h) >= 4.0 and abs_v >= 0.07)
        if not z_passes:
            blocked_at = "weak_velocity"
            reason = f"|v_1h|={abs_v:.1%} < {min_vel:.0%} (z={z_1h:.1f if z_1h else 'n/a'})"

    v1s = f"{v_1h:+.1%}" if v_1h is not None else "n/a"
    v6s = f"{v_6h:+.1%}" if v_6h is not None else "n/a"
    zs = f"{z_1h:.1f}" if z_1h is not None else "n/a"

    status = f"BLOCKED@{blocked_at}: {reason}" if blocked_at else "→ PASSES TO HAIKU"
    mtype = "SPORT" if sport else "      "
    print(f"  {mtype} | YES {yes:.0%} | v1h={v1s:>7} v6h={v6s:>7} z={zs:>5} | spr={spr:.0%} liq=${liq:>8,.0f} | {status} | {q[:50]}")

    if blocked_at:
        blocked_summary[blocked_at] = blocked_summary.get(blocked_at, 0) + 1
    else:
        candidates.append(q[:60])

print(f"\n{'='*100}")
print(f"FILTER SUMMARY (markets with velocity alerts only):")
for k, v in sorted(blocked_summary.items(), key=lambda x: -x[1]):
    print(f"  {k}: {v}")
print(f"  → passes to Haiku: {len(candidates)}")
if candidates:
    print(f"\nHAIKU CANDIDATES:")
    for c in candidates:
        print(f"  • {c}")

# 4. Check: are there markets with big moves we're NOT tracking?
print(f"\n{'='*100}")
print(f"SNAPSHOT GAPS — markets with stale/missing data")
print(f"{'='*100}")
stale = conn.execute("""
    SELECT m.market_id, m.question, m.yes_price, m.volume,
           (SELECT COUNT(*) FROM odds_snapshots o WHERE o.market_id = m.market_id
            AND o.ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')) as snaps_1h,
           (SELECT MAX(ts) FROM odds_snapshots o WHERE o.market_id = m.market_id) as last_snap
    FROM musk_markets m
    WHERE m.last_seen > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
    AND m.volume > 50000
    ORDER BY snaps_1h ASC
    LIMIT 15
""").fetchall()
for r in stale:
    last = r["last_snap"][:16] if r["last_snap"] else "never"
    print(f"  {r['snaps_1h']:>3} snaps/1h | last={last} | vol=${r['volume']:>12,.0f} | {r['question'][:55]}")

# 5. Check the min_span logic — are we throwing away good data?
print(f"\n{'='*100}")
print(f"SPAN CHECK — markets where span < 30min killed the velocity")
print(f"{'='*100}")
for m in markets:
    mid = m["market_id"]
    q = m["question"] or ""
    yes = m["yes_price"] or 0
    h1 = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
        ORDER BY ts ASC
    """, (mid,)).fetchall()
    if len(h1) >= 2:
        t1 = datetime.fromisoformat(h1[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(h1[-1]["ts"].replace("Z", "+00:00"))
        span = (t2 - t1).total_seconds() / 60
        if span < 30:
            raw_v = yes - h1[0]["yes_price"]
            if abs(raw_v) >= 0.05:
                print(f"  span={span:.0f}m | {len(h1)} snaps | v_raw={raw_v:+.1%} | {q[:55]}")

# 6. Low entry odds filter check — is 50% too aggressive?
print(f"\n{'='*100}")
print(f"LOW ENTRY ODDS FILTER — markets blocked at <50%")
print(f"{'='*100}")
for m in markets:
    q = m["question"] or ""
    yes = m["yes_price"] or 0
    mid = m["market_id"]
    h1 = conn.execute("""
        SELECT yes_price, ts FROM odds_snapshots
        WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')
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
        print(f"  {side} @ {entry:.0%} | v_1h={v_1h:+.1%} | YES={yes:.0%} | {q[:55]}")

conn.close()
