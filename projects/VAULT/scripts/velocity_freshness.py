import sqlite3
conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

mid = "1333269"  # DeepSeek V4

# Recent snapshots - last 12 hours
snaps = conn.execute(
    "SELECT ts, yes_price FROM odds_snapshots "
    "WHERE market_id = ? AND ts > datetime('now', '-12 hours') ORDER BY ts ASC",
    (mid,)
).fetchall()

print(f"DeepSeek V4 - last 12h ({len(snaps)} snapshots):")
step = max(1, len(snaps) // 25)
prev = None
for i, s in enumerate(snaps):
    if i % step == 0 or i == len(snaps) - 1:
        delta = ""
        if prev is not None:
            d = s["yes_price"] - prev
            delta = f" ({d:+.2%} from prev sample)"
        print(f"  {s['ts'][:16]} | YES {s['yes_price']:.2%}{delta}")
        prev = s["yes_price"]

# Velocity window: what prices is v_1h comparing?
print("\nVelocity window (latest snapshot):")
if snaps:
    latest = snaps[-1]
    one_h_ago = conn.execute(
        "SELECT ts, yes_price FROM odds_snapshots "
        "WHERE market_id = ? AND ts <= datetime(?, '-1 hour') ORDER BY ts DESC LIMIT 1",
        (mid, latest["ts"])
    ).fetchone()
    six_h_ago = conn.execute(
        "SELECT ts, yes_price FROM odds_snapshots "
        "WHERE market_id = ? AND ts <= datetime(?, '-6 hours') ORDER BY ts DESC LIMIT 1",
        (mid, latest["ts"])
    ).fetchone()

    print(f"  Now:    {latest['ts'][:16]} YES={latest['yes_price']:.2%}")
    if one_h_ago:
        v1 = latest["yes_price"] - one_h_ago["yes_price"]
        print(f"  1h ago: {one_h_ago['ts'][:16]} YES={one_h_ago['yes_price']:.2%} -> v_1h = {v1:+.2%}")
    if six_h_ago:
        v6 = latest["yes_price"] - six_h_ago["yes_price"]
        print(f"  6h ago: {six_h_ago['ts'][:16]} YES={six_h_ago['yes_price']:.2%} -> v_6h = {v6:+.2%}")

# Actual movement in last 3h vs last 8h
for hours in [1, 3, 8]:
    window = conn.execute(
        "SELECT MIN(yes_price) as lo, MAX(yes_price) as hi FROM odds_snapshots "
        "WHERE market_id = ? AND ts > datetime('now', ?)",
        (mid, f"-{hours} hours")
    ).fetchone()
    first_p = conn.execute(
        "SELECT yes_price FROM odds_snapshots "
        "WHERE market_id = ? AND ts > datetime('now', ?) ORDER BY ts ASC LIMIT 1",
        (mid, f"-{hours} hours")
    ).fetchone()
    last_p = conn.execute(
        "SELECT yes_price FROM odds_snapshots "
        "WHERE market_id = ? AND ts > datetime('now', ?) ORDER BY ts DESC LIMIT 1",
        (mid, f"-{hours} hours")
    ).fetchone()
    if first_p and last_p:
        net = last_p[0] - first_p[0]
        print(f"\nLast {hours}h: YES {first_p[0]:.2%} -> {last_p[0]:.2%} (net {net:+.2%}, range {window['lo']:.2%}-{window['hi']:.2%})")

# When did the big move happen?
print("\nHourly breakdown (entire history):")
all_snaps = conn.execute(
    "SELECT ts, yes_price FROM odds_snapshots WHERE market_id = ? ORDER BY ts ASC",
    (mid,)
).fetchall()
if all_snaps:
    # Group by hour
    from collections import defaultdict
    hourly = defaultdict(list)
    for s in all_snaps:
        hour_key = s["ts"][:13]  # YYYY-MM-DDTHH
        hourly[hour_key].append(s["yes_price"])

    for hk in sorted(hourly.keys()):
        prices = hourly[hk]
        start, end = prices[0], prices[-1]
        delta = end - start
        if abs(delta) >= 0.005:  # only show hours with >= 0.5pp movement
            print(f"  {hk}:00 | {start:.1%} -> {end:.1%} ({delta:+.1%}) [{len(prices)} snaps]")

conn.close()
