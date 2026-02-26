#!/usr/bin/env python3
"""Deep safeguard analysis - match each losing sell to entry conditions."""
import sqlite3
import re

conn = sqlite3.connect('vault.db')
conn.row_factory = sqlite3.Row
c = conn.cursor()

# Get all buys (prediction_buy ledger entries)
c.execute('''
    SELECT id, ts, amount, description, reference_id, balance_after
    FROM ledger
    WHERE entry_type = 'prediction_buy'
    ORDER BY ts
''')

all_buys = []
for r in c.fetchall():
    desc = r['description'] or ''
    mkt_match = re.search(r"'([^']+)'", desc)
    market = mkt_match.group(1) if mkt_match else 'unknown'
    odds_match = re.search(r'@ (\d+)%', desc)
    entry_odds = int(odds_match.group(1)) if odds_match else None
    stake_match = re.search(r'\(\$?([\d.]+)\)', desc)
    stake = float(stake_match.group(1)) if stake_match else abs(r['amount'])
    all_buys.append({
        'ledger_id': r['id'],
        'ts': r['ts'],
        'stake': stake,
        'market': market,
        'entry_odds': entry_odds,
        'balance_after': r['balance_after'],
        'balance_before': r['balance_after'] + stake,
        'desc': desc,
        'prediction_id': r['reference_id'],
    })

# Get all sells with P&L
c.execute('''
    SELECT id, ts, amount, description, reference_id
    FROM ledger
    WHERE entry_type = 'prediction_sell'
    ORDER BY ts
''')

all_sells = []
for r in c.fetchall():
    desc = r['description'] or ''
    match = re.search(r'P&L: \$([+-]?[\d.]+)', desc)
    if not match:
        continue
    pnl = float(match.group(1))
    mkt_match = re.search(r"'([^']+)'", desc)
    market = mkt_match.group(1) if mkt_match else 'unknown'
    odds_match = re.search(r'@ (\d+)%', desc)
    exit_odds = int(odds_match.group(1)) if odds_match else None
    all_sells.append({
        'ledger_id': r['id'],
        'ts': r['ts'],
        'sell_amount': r['amount'],
        'pnl': pnl,
        'market': market,
        'exit_odds': exit_odds,
        'desc': desc,
        'prediction_id': r['reference_id'],
    })

losses = [s for s in all_sells if s['pnl'] < -0.01]
wins = [s for s in all_sells if s['pnl'] > 0.01]

# Group buys by market
market_buys = {}
for b in all_buys:
    market_buys.setdefault(b['market'], []).append(b)

# Group losses by market
loss_markets = {}
for l in losses:
    loss_markets.setdefault(l['market'], []).append(l)

# Group wins by market
win_markets = {}
for w in wins:
    win_markets.setdefault(w['market'], []).append(w)

print("=" * 70)
print("VAULT SAFEGUARD DEEP ANALYSIS")
print("=" * 70)
print(f"Total buys: {len(all_buys)} (${sum(b['stake'] for b in all_buys):.2f} total staked)")
print(f"Total sells: {len(all_sells)}")
print(f"Losing sells: {len(losses)} (${sum(l['pnl'] for l in losses):.2f})")
print(f"Winning sells: {len(wins)} (${sum(w['pnl'] for w in wins):.2f})")
print()

# ==========================================
# SAFEGUARD 1: OSCILLATION DAMPENER
# Markets where VAULT bought into 3+ times, lost money overall
# ==========================================
print("=" * 70)
print("SAFEGUARD 1: OSCILLATION DAMPENER")
print("Prevents repeated buy-sell-buy cycles on the same market")
print("=" * 70)

oscillation_losses_prevented = 0
oscillation_wins_blocked = 0

for market, buys in sorted(market_buys.items(), key=lambda x: -len(x[1])):
    if len(buys) < 3:
        continue

    mkt_losses = loss_markets.get(market, [])
    mkt_wins = win_markets.get(market, [])
    total_loss = sum(l['pnl'] for l in mkt_losses)
    total_win = sum(w['pnl'] for w in mkt_wins)

    # With oscillation dampener, only 1st entry + 1 re-entry allowed (2 entries max)
    # Additional entries beyond 2 are blocked
    excess = len(buys) - 2
    excess_ratio = excess / len(buys)

    prevented = abs(total_loss) * excess_ratio if total_loss < 0 else 0
    blocked = total_win * excess_ratio if total_win > 0 else 0

    if len(buys) >= 4 or abs(total_loss) > 1.0:
        print(f"\n  {market[:65]}")
        print(f"    Entries: {len(buys)} | Losses: ${total_loss:.2f} | Wins: ${total_win:.2f}")
        print(f"    Excess entries blocked: {excess} ({excess_ratio:.0%} of activity)")
        print(f"    Losses prevented: ${prevented:.2f} | Wins blocked: ${blocked:.2f}")

    oscillation_losses_prevented += prevented
    oscillation_wins_blocked += blocked

print(f"\n  TOTAL: Losses prevented: ${oscillation_losses_prevented:.2f} | Wins blocked: ${oscillation_wins_blocked:.2f}")
print(f"  NET BENEFIT: ${oscillation_losses_prevented - oscillation_wins_blocked:.2f}")

# ==========================================
# SAFEGUARD 2: MOMENTUM ADD CAP (max 5 adds per position)
# ==========================================
print()
print("=" * 70)
print("SAFEGUARD 2: MOMENTUM ADD CAP (max 5 adds per position)")
print("Caps the number of momentum adds to any single position at 5")
print("=" * 70)

# Identify momentum add buys by their reasoning
momentum_markets = {}
for b in all_buys:
    # Check if this was a momentum add buy
    # We need to check the cycle reasoning
    pass

# Alternative: check for markets with many small buys in quick succession
add_cap_losses_prevented = 0
add_cap_wins_blocked = 0

for market, buys in market_buys.items():
    if len(buys) <= 5:
        continue

    mkt_losses = loss_markets.get(market, [])
    mkt_wins = win_markets.get(market, [])
    total_loss = sum(l['pnl'] for l in mkt_losses)
    total_win = sum(w['pnl'] for w in mkt_wins)

    # Only adds beyond 5 are blocked
    excess = len(buys) - 5
    excess_ratio = excess / len(buys)

    prevented = abs(total_loss) * excess_ratio if total_loss < 0 else 0
    blocked = total_win * excess_ratio if total_win > 0 else 0

    if len(buys) > 8:
        print(f"\n  {market[:65]}")
        print(f"    Total buys: {len(buys)} | Losses: ${total_loss:.2f} | Wins: ${total_win:.2f}")
        print(f"    Excess (>5): {excess} blocked | Prevented: ${prevented:.2f} | Blocked: ${blocked:.2f}")

    add_cap_losses_prevented += prevented
    add_cap_wins_blocked += blocked

print(f"\n  TOTAL: Losses prevented: ${add_cap_losses_prevented:.2f} | Wins blocked: ${add_cap_wins_blocked:.2f}")
print(f"  NET BENEFIT: ${add_cap_losses_prevented - add_cap_wins_blocked:.2f}")

# ==========================================
# SAFEGUARD 3: HIGH ENTRY ODDS BLOCK (>80%)
# ==========================================
print()
print("=" * 70)
print("SAFEGUARD 3: HIGH ENTRY ODDS BLOCK (block buys >80%)")
print("Prevents buying contracts already priced >80% (limited upside)")
print("=" * 70)

high_odds_losses_prevented = 0
high_odds_wins_blocked = 0

# Find all buys at >80% odds
high_odds_buys = [b for b in all_buys if b['entry_odds'] and b['entry_odds'] > 80]
high_odds_markets = set(b['market'] for b in high_odds_buys)

for market in high_odds_markets:
    buys_at_high = [b for b in market_buys.get(market, []) if b['entry_odds'] and b['entry_odds'] > 80]
    all_market_buys = market_buys.get(market, [])
    high_ratio = len(buys_at_high) / len(all_market_buys) if all_market_buys else 0

    mkt_losses = loss_markets.get(market, [])
    mkt_wins = win_markets.get(market, [])
    total_loss = sum(l['pnl'] for l in mkt_losses)
    total_win = sum(w['pnl'] for w in mkt_wins)

    prevented = abs(total_loss) * high_ratio if total_loss < 0 else 0
    blocked = total_win * high_ratio if total_win > 0 else 0

    if prevented > 0.50 or blocked > 0.50:
        print(f"\n  {market[:65]}")
        print(f"    High-odds buys: {len(buys_at_high)}/{len(all_market_buys)}")
        print(f"    Losses: ${total_loss:.2f} | Wins: ${total_win:.2f}")
        print(f"    Prevented: ${prevented:.2f} | Blocked: ${blocked:.2f}")

    high_odds_losses_prevented += prevented
    high_odds_wins_blocked += blocked

print(f"\n  TOTAL: Losses prevented: ${high_odds_losses_prevented:.2f} | Wins blocked: ${high_odds_wins_blocked:.2f}")
print(f"  NET BENEFIT: ${high_odds_losses_prevented - high_odds_wins_blocked:.2f}")

# ==========================================
# SAFEGUARD 4: POSITION SIZE CAP (max 20% of balance)
# ==========================================
print()
print("=" * 70)
print("SAFEGUARD 4: POSITION SIZE CAP (max 20% of balance)")
print("Caps any single bet at 20% of pre-trade balance")
print("=" * 70)

oversized_losses_prevented = 0
oversized_wins_blocked = 0
oversized_details = []

for b in all_buys:
    if b['balance_before'] > 0 and b['stake'] / b['balance_before'] > 0.20:
        pct = b['stake'] / b['balance_before']
        excess_pct = (pct - 0.20) / pct  # portion of stake above 20%

        # Find if this market had losses or wins
        mkt_losses = loss_markets.get(b['market'], [])
        mkt_wins = win_markets.get(b['market'], [])
        total_loss = sum(l['pnl'] for l in mkt_losses)
        total_win = sum(w['pnl'] for w in mkt_wins)
        total_buys = len(market_buys.get(b['market'], []))

        # Attribute proportional loss/win prevention
        if total_loss < 0:
            prevented = abs(total_loss) * excess_pct / total_buys
            oversized_losses_prevented += prevented
        if total_win > 0:
            blocked = total_win * excess_pct / total_buys
            oversized_wins_blocked += blocked

        oversized_details.append({
            'market': b['market'],
            'stake': b['stake'],
            'balance': b['balance_before'],
            'pct': pct,
        })

for d in sorted(oversized_details, key=lambda x: -x['pct'])[:10]:
    print(f"  ${d['stake']:.2f} = {d['pct']:.0%} of ${d['balance']:.2f} on {d['market'][:50]}")

print(f"\n  TOTAL: Losses prevented: ${oversized_losses_prevented:.2f} | Wins blocked: ${oversized_wins_blocked:.2f}")
print(f"  NET BENEFIT: ${oversized_losses_prevented - oversized_wins_blocked:.2f}")

# ==========================================
# SAFEGUARD 5: SAME-UNDERLYING CONCENTRATION
# Markets about same topic (e.g., Musk tweets different ranges)
# ==========================================
print()
print("=" * 70)
print("SAFEGUARD 5: SAME-UNDERLYING CONCENTRATION")
print("Limits exposure to correlated markets (e.g., multiple Musk tweet ranges)")
print("=" * 70)

# Group by underlying theme
def get_theme(market):
    m = market.lower()
    if 'musk' in m and ('tweet' in m or 'post' in m):
        return 'Musk tweets'
    elif 'tesla' in m or 'tsla' in m:
        return 'Tesla'
    elif 'grok' in m:
        return 'Grok'
    elif 'goldman' in m or 'spacex' in m:
        return 'GS/SpaceX'
    elif 'starship' in m:
        return 'Starship'
    elif 'bitcoin' in m:
        return 'Bitcoin'
    elif 'ethereum' in m:
        return 'Ethereum'
    else:
        return market[:30]

theme_buys = {}
theme_losses = {}
theme_wins = {}

for b in all_buys:
    theme = get_theme(b['market'])
    theme_buys.setdefault(theme, []).append(b)

for l in losses:
    theme = get_theme(l['market'])
    theme_losses.setdefault(theme, []).append(l)

for w in wins:
    theme = get_theme(w['market'])
    theme_wins.setdefault(theme, []).append(w)

theme_losses_prevented = 0
theme_wins_blocked = 0

for theme in sorted(theme_buys.keys(), key=lambda t: -len(theme_buys[t])):
    buys = theme_buys[theme]
    distinct_markets = len(set(b['market'] for b in buys))

    if distinct_markets <= 3:
        continue

    total_staked = sum(b['stake'] for b in buys)
    tl = sum(l['pnl'] for l in theme_losses.get(theme, []))
    tw = sum(w['pnl'] for w in theme_wins.get(theme, []))

    # Cap at 3 distinct markets per theme
    excess_ratio = (distinct_markets - 3) / distinct_markets

    prevented = abs(tl) * excess_ratio if tl < 0 else 0
    blocked = tw * excess_ratio if tw > 0 else 0

    theme_losses_prevented += prevented
    theme_wins_blocked += blocked

    print(f"\n  {theme}:")
    print(f"    Distinct markets: {distinct_markets} | Total buys: {len(buys)} | Staked: ${total_staked:.2f}")
    print(f"    Losses: ${tl:.2f} | Wins: ${tw:.2f}")
    print(f"    With cap (3 markets max): Prevented: ${prevented:.2f} | Blocked: ${blocked:.2f}")

print(f"\n  TOTAL: Losses prevented: ${theme_losses_prevented:.2f} | Wins blocked: ${theme_wins_blocked:.2f}")
print(f"  NET BENEFIT: ${theme_losses_prevented - theme_wins_blocked:.2f}")

# ==========================================
# GRAND SUMMARY
# ==========================================
print()
print("=" * 70)
print("GRAND SUMMARY")
print("=" * 70)

total_loss = sum(l['pnl'] for l in losses)

safeguards = [
    ("1. Oscillation dampener", oscillation_losses_prevented, oscillation_wins_blocked),
    ("2. Momentum add cap (5)", add_cap_losses_prevented, add_cap_wins_blocked),
    ("3. High entry odds block (>80%)", high_odds_losses_prevented, high_odds_wins_blocked),
    ("4. Position size cap (20%)", oversized_losses_prevented, oversized_wins_blocked),
    ("5. Theme concentration cap", theme_losses_prevented, theme_wins_blocked),
]

total_prevented = 0
total_blocked = 0

for name, prevented, blocked in safeguards:
    net = prevented - blocked
    total_prevented += prevented
    total_blocked += blocked
    print(f"  {name}")
    print(f"    Losses prevented: ${prevented:.2f}")
    print(f"    Wins blocked:     ${blocked:.2f}")
    print(f"    Net benefit:      ${net:.2f}")
    print()

print(f"  COMBINED:")
print(f"    Total losses prevented: ${total_prevented:.2f} (of ${abs(total_loss):.2f} total)")
print(f"    Total wins blocked:     ${total_blocked:.2f}")
print(f"    Net benefit:            ${total_prevented - total_blocked:.2f}")
print()

# Note about overlap
print("  NOTE: These safeguards overlap significantly. The same losing trade may")
print("  be caught by multiple safeguards. The combined figure is an upper bound,")
print("  not additive. A realistic single-best safeguard would save roughly")
print(f"  ${max(s[1]-s[2] for s in safeguards):.2f} (the best individual safeguard's net benefit).")

conn.close()
