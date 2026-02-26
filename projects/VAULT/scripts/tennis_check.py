"""Check the Mirra Andreeva tennis match — biggest missed opportunity."""
import sqlite3
from datetime import datetime, timezone

conn = sqlite3.connect("vault.db")
conn.row_factory = sqlite3.Row

# Find the market
rows = conn.execute(
    "SELECT * FROM musk_markets WHERE question LIKE '%Mirra%'"
).fetchall()

for r in rows:
    mid = r["market_id"]
    print(f"Market: {r['question']}")
    print(f"  ID: {mid}")
    print(f"  YES: {r['yes_price']:.0%}, vol: ${r['volume']:,.0f}")
    print(f"  Liquidity: ${r['liquidity']:,.0f}" if r['liquidity'] else "  Liquidity: unknown")
    print(f"  Spread: {r['spread']:.0%}" if r['spread'] else "  Spread: unknown")
    print(f"  Game start: {r['game_start_time']}")
    print(f"  Event: {r['event_title']}")
    print(f"  First seen: {r['first_seen']}")
    print(f"  Last seen: {r['last_seen']}")

    # All snapshots
    snaps = conn.execute(
        "SELECT yes_price, ts, cycle_id FROM odds_snapshots WHERE market_id = ? ORDER BY ts ASC",
        (mid,)
    ).fetchall()
    print(f"\n  ALL SNAPSHOTS ({len(snaps)}):")
    for s in snaps:
        print(f"    {s['ts'][:19]} | YES {s['yes_price']:.0%} | cycle {s['cycle_id']}")

    # Check: when did this market first appear and how quickly did it accumulate data?
    if len(snaps) >= 2:
        t1 = datetime.fromisoformat(snaps[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(snaps[-1]["ts"].replace("Z", "+00:00"))
        total_span = (t2 - t1).total_seconds() / 60
        print(f"\n  Total span: {total_span:.0f} minutes")
        print(f"  Move: {snaps[0]['yes_price']:.0%} → {snaps[-1]['yes_price']:.0%} ({snaps[-1]['yes_price'] - snaps[0]['yes_price']:+.0%})")

        # At what point would we have had 30min span?
        for i, s in enumerate(snaps):
            ti = datetime.fromisoformat(s["ts"].replace("Z", "+00:00"))
            span_from_start = (ti - t1).total_seconds() / 60
            if span_from_start >= 30:
                v_at_30 = s["yes_price"] - snaps[0]["yes_price"]
                print(f"\n  At 30min span mark (snapshot {i}):")
                print(f"    Time: {s['ts'][:19]}")
                print(f"    YES: {s['yes_price']:.0%}")
                print(f"    v_1h would have been: {v_at_30:+.0%}")
                break
        else:
            print(f"\n  NEVER reached 30min span! Total span was only {total_span:.0f}m")
            print(f"  The entire match happened within <30 min of tracking")

# Also check the Dota 2 match
print("\n" + "="*80)
rows = conn.execute(
    "SELECT * FROM musk_markets WHERE question LIKE '%Team Spirit%Falcons%'"
).fetchall()
for r in rows:
    mid = r["market_id"]
    print(f"\nMarket: {r['question']}")
    print(f"  YES: {r['yes_price']:.0%}, game_start: {r['game_start_time']}")
    snaps = conn.execute(
        "SELECT yes_price, ts FROM odds_snapshots WHERE market_id = ? ORDER BY ts ASC",
        (mid,)
    ).fetchall()
    print(f"  Snapshots: {len(snaps)}")
    for s in snaps:
        print(f"    {s['ts'][:19]} | YES {s['yes_price']:.0%}")

# Also check Coco Gauff match (another tennis)
print("\n" + "="*80)
rows = conn.execute(
    "SELECT * FROM musk_markets WHERE question LIKE '%Coco Gauff%'"
).fetchall()
for r in rows:
    mid = r["market_id"]
    print(f"\nMarket: {r['question']}")
    print(f"  YES: {r['yes_price']:.0%}, game_start: {r['game_start_time']}")
    snaps = conn.execute(
        "SELECT yes_price, ts FROM odds_snapshots WHERE market_id = ? ORDER BY ts ASC",
        (mid,)
    ).fetchall()
    print(f"  Snapshots: {len(snaps)}")
    if snaps:
        print(f"  First: {snaps[0]['ts'][:19]} YES={snaps[0]['yes_price']:.0%}")
        print(f"  Last:  {snaps[-1]['ts'][:19]} YES={snaps[-1]['yes_price']:.0%}")
        t1 = datetime.fromisoformat(snaps[0]["ts"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(snaps[-1]["ts"].replace("Z", "+00:00"))
        print(f"  Span: {(t2-t1).total_seconds()/60:.0f}m")

conn.close()
