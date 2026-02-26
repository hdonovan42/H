"""Analyse velocity at entry for side-switch trades."""
import sqlite3
import re

db = sqlite3.connect('/home/hq/vault/vault.db')

FILTER = "entry_reasoning LIKE 'Sharp move%' AND status='closed'"

def parse_velocity(reasoning):
    """Extract v_1h from entry reasoning string."""
    if not reasoning:
        return None
    m = re.search(r'([+-]?\d+)%/1h', reasoning)
    return int(m.group(1)) if m else None

# Get all both-side market IDs
both_side = db.execute(f"""
    SELECT market_id FROM predictions
    WHERE {FILTER}
    GROUP BY market_id
    HAVING SUM(CASE WHEN side='YES' THEN 1 ELSE 0 END) > 0
       AND SUM(CASE WHEN side='NO' THEN 1 ELSE 0 END) > 0
""").fetchall()

print("=== SIDE-SWITCH TRADES: VELOCITY AT ENTRY ===\n")
print(f"{'Market':<52} {'Side':>4} {'v1h':>5} {'PnL':>7} {'Cost':>6} {'Verdict'}")
print("-" * 90)

all_switches = []
for (mid,) in both_side:
    first = db.execute(f"""
        SELECT id, side FROM predictions
        WHERE market_id=? AND {FILTER}
        ORDER BY id ASC LIMIT 1
    """, (mid,)).fetchone()
    first_side = first[1]

    # Get question
    q = db.execute("SELECT SUBSTR(question,1,50) FROM predictions WHERE market_id=? LIMIT 1", (mid,)).fetchone()[0]

    # First-side trades
    first_trades = db.execute(f"""
        SELECT id, side, ROUND(pnl,2), ROUND(cost_basis,2), entry_reasoning
        FROM predictions WHERE market_id=? AND side=? AND {FILTER} ORDER BY id
    """, (mid, first_side)).fetchall()

    # Switch trades
    switches = db.execute(f"""
        SELECT id, side, ROUND(pnl,2), ROUND(cost_basis,2), entry_reasoning
        FROM predictions WHERE market_id=? AND side!=? AND {FILTER} ORDER BY id
    """, (mid, first_side)).fetchall()

    first_pnl = sum(t[2] for t in first_trades)
    switch_pnl = sum(s[2] for s in switches)

    print(f"\n{q}")
    print(f"  First side: {first_side} ({len(first_trades)}t, {first_pnl:+.2f}) | Switches: {len(switches)}t, {switch_pnl:+.2f}")

    for s in switches:
        v1h = parse_velocity(s[4])
        v_str = f"{v1h:+d}%" if v1h is not None else "?"
        verdict = "WIN" if s[2] > 0 else "LOSE"
        print(f"  #{s[0]:>3} {s[1]:>3} v1h={v_str:>5} pnl={s[2]:+.2f} cost={s[3]:>5} [{verdict}]")
        all_switches.append((s[0], s[1], v1h, s[2], s[3], q))

# Now simulate different velocity thresholds for side-switches
print("\n\n=== WHAT-IF: REQUIRE HIGHER VELOCITY FOR SIDE-SWITCHES ===\n")
print(f"{'Threshold':>12} {'Blocked':>8} {'Allowed':>8} {'Blocked PnL':>12} {'Allowed PnL':>12} {'Net vs actual':>14}")
print("-" * 72)

actual_total = sum(s[3] for s in all_switches)

for threshold in [10, 15, 20, 25, 30, 35, 40]:
    blocked = [(s[0], s[3]) for s in all_switches if s[2] is not None and abs(s[2]) < threshold]
    allowed = [(s[0], s[3]) for s in all_switches if s[2] is None or abs(s[2]) >= threshold]
    blocked_pnl = sum(b[1] for b in blocked)
    allowed_pnl = sum(a[1] for a in allowed)
    net_benefit = -blocked_pnl
    print(f"{threshold:>10}%  {len(blocked):>7}  {len(allowed):>7}  ${blocked_pnl:>+10.2f}  ${allowed_pnl:>+10.2f}  ${net_benefit:>+12.2f}")

# Check specific profitable switches
print("\n\n=== KEY PROFITABLE SWITCHES (would they pass higher thresholds?) ===\n")
profitable_switches = [(s[0], s[1], s[2], s[3], s[4], s[5]) for s in all_switches if s[3] > 1.0]
profitable_switches.sort(key=lambda x: -x[3])

for s in profitable_switches:
    v_str = f"{s[2]:+d}%" if s[2] is not None else "?"
    passes_20 = "PASS" if s[2] is not None and abs(s[2]) >= 20 else "BLOCK"
    passes_25 = "PASS" if s[2] is not None and abs(s[2]) >= 25 else "BLOCK"
    passes_30 = "PASS" if s[2] is not None and abs(s[2]) >= 30 else "BLOCK"
    print(f"#{s[0]} {s[1]} v1h={v_str:>5} pnl={s[3]:+.2f} | @20%:{passes_20} @25%:{passes_25} @30%:{passes_30}")
    print(f"  {s[5]}")

db.close()
