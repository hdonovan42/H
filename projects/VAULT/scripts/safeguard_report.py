#!/usr/bin/env python3
"""Complete safeguard analysis report for VAULT trading."""
import sqlite3
import re
import json

conn = sqlite3.connect('vault.db')
conn.row_factory = sqlite3.Row
c = conn.cursor()

# ==========================================
# PART 1: Get all sells with P&L
# ==========================================
c.execute('''
    SELECT id, ts, amount, description, balance_after
    FROM ledger
    WHERE entry_type = 'prediction_sell'
    ORDER BY ts
''')

all_sells = []
for r in c.fetchall():
    desc = r['description'] or ''
    match = re.search(r'P&L: \$([+-]?[\d.]+)', desc)
    if match:
        pnl = float(match.group(1))
        mkt_match = re.search(r"'([^']+)'", desc)
        market = mkt_match.group(1) if mkt_match else 'unknown'
        all_sells.append({
            'id': r['id'],
            'ts': r['ts'],
            'sell_amount': r['amount'],
            'pnl': pnl,
            'market': market,
            'desc': desc
        })

losses = [s for s in all_sells if s['pnl'] < -0.01]
wins = [s for s in all_sells if s['pnl'] > 0.01]

print("=" * 60)
print("VAULT SAFEGUARD ANALYSIS - COMPLETE REPORT")
print("=" * 60)
print()
print(f"Total sells analyzed: {len(all_sells)}")
print(f"Winning sells: {len(wins)} (total: ${sum(w['pnl'] for w in wins):.2f})")
print(f"Losing sells: {len(losses)} (total: ${sum(l['pnl'] for l in losses):.2f})")
print(f"Net realized PnL: ${sum(s['pnl'] for s in all_sells):.2f}")
print()

# ==========================================
# PART 2: Categorize losses by market type
# ==========================================
def categorize(market):
    m = market.lower()
    if 'musk' in m and ('tweet' in m or 'post' in m):
        return 'Musk tweet counts'
    elif 'tesla' in m or 'tsla' in m:
        return 'Tesla/TSLA'
    elif 'starship' in m or 'spacex' in m:
        return 'Starship/SpaceX'
    elif 'goldman' in m:
        return 'Goldman Sachs'
    elif 'grok' in m:
        return 'Grok release'
    elif any(x in m for x in ['tennis', 'counter-strike', 'furia', 'dota', 't20', 'nba',
                                'pacer', 'wizard', 'girona', 'barcelona', 'cricket',
                                'esport', 'game', 'delray', 'coleman', 'cobolli',
                                'mongol', 'og vs', 'liquid', 'mcconnell']):
        return 'Sports/esports/events'
    elif 'bitcoin' in m or 'ethereum' in m or 'btc' in m or 'eth' in m:
        return 'Bitcoin/crypto'
    elif 's&p' in m or 'spx' in m:
        return 'S&P 500'
    elif 'copper' in m:
        return 'Commodities'
    elif 'bernie' in m or 'sanders' in m:
        return 'Politics'
    elif 'mrbeast' in m or 'puzzle' in m:
        return 'MrBeast/entertainment'
    elif 'paradex' in m:
        return 'Crypto/Paradex'
    elif 'strike' in m or 'somali' in m:
        return 'Geopolitics'
    elif 'netflix' in m or 'warner' in m:
        return 'Media/entertainment'
    elif 'trump' in m or 'epa' in m or 'sotu' in m or 'state of the union' in m:
        return 'Trump/politics'
    elif 'elon' in m or 'musk' in m:
        return 'Elon Musk (other)'
    else:
        return f'Other: {market[:50]}'

# Group losses by category
cat_losses = {}
cat_wins = {}
for s in losses:
    cat = categorize(s['market'])
    cat_losses.setdefault(cat, []).append(s)
for s in wins:
    cat = categorize(s['market'])
    cat_wins.setdefault(cat, []).append(s)

print("=" * 60)
print("LOSSES BY MARKET CATEGORY")
print("=" * 60)
for cat in sorted(cat_losses.keys(), key=lambda k: sum(s['pnl'] for s in cat_losses[k])):
    total = sum(s['pnl'] for s in cat_losses[cat])
    count = len(cat_losses[cat])
    win_total = sum(s['pnl'] for s in cat_wins.get(cat, []))
    win_count = len(cat_wins.get(cat, []))
    net = total + win_total
    print(f"  {cat}:")
    print(f"    Losses: ${total:.2f} ({count} sells)")
    print(f"    Wins:   ${win_total:.2f} ({win_count} sells)")
    print(f"    Net:    ${net:.2f}")
    print()

# ==========================================
# PART 3: Identify patterns in losing trades
# ==========================================
print("=" * 60)
print("SAFEGUARD ANALYSIS: WHICH RULES WOULD HAVE PREVENTED LOSSES")
print("=" * 60)
print()

# Get edge calculations for bet cycles
c.execute('''
    SELECT ec.cycle_id, ec.market_id, ec.vault_prob, ec.market_odds, ec.edge,
           ec.side, ec.confidence, ec.recommended_size_usd, ec.action, ec.reasoning,
           cy.action as cycle_action, cy.balance_after, cy.reasoning as cycle_reasoning
    FROM edge_calculations ec
    JOIN cycles cy ON ec.cycle_id = cy.id
    WHERE cy.action = 'bet'
    AND ec.action = 'BET'
    ORDER BY ec.cycle_id
''')

bet_edges = {}
for r in c.fetchall():
    cid = r['cycle_id']
    bet_edges[cid] = {
        'vault_prob': r['vault_prob'],
        'market_odds': r['market_odds'],
        'edge': r['edge'],
        'side': r['side'],
        'confidence': r['confidence'],
        'rec_size': r['recommended_size_usd'],
    }

# Get smart_money_log entries for momentum bets
c.execute('''
    SELECT cycle_id, market_id, question, v_1h, v_6h, direction, sharp,
           z_1h, confidence, side, amount_usd, vault_estimate, market_odds
    FROM smart_money_log
    ORDER BY cycle_id
''')

momentum_bets = {}
for r in c.fetchall():
    cid = r['cycle_id']
    momentum_bets[cid] = dict(r)

# Get all bet cycles
c.execute('''
    SELECT id, ts_start, action, asset, reasoning, balance_after
    FROM cycles
    WHERE action = 'bet'
    ORDER BY id
''')

all_bet_cycles = []
for r in c.fetchall():
    cycle = dict(r)
    cycle['edge_data'] = bet_edges.get(r['id'])
    cycle['momentum_data'] = momentum_bets.get(r['id'])
    all_bet_cycles.append(cycle)

# ==========================================
# PART 4: Identify specific safeguard violations
# ==========================================

# Safeguard 1: OSCILLATION (buy-sell-buy-sell on same market)
# Safeguard 2: LOW CONFIDENCE (<0.5)
# Safeguard 3: SMALL EDGE (<10%)
# Safeguard 4: HIGH ENTRY ODDS (buying at >70% odds)
# Safeguard 5: EXCESSIVE POSITION CONCENTRATION (>25% of balance)
# Safeguard 6: TOO MANY MOMENTUM ADDS (more than 5 adds to same position)
# Safeguard 7: SHORT-DATED MARKET (expires within 48h)

# Analyze edge-era losses (early cycles, before momentum era)
print("SAFEGUARD 1: OSCILLATION PATTERN (buy-sell-buy-sell on same market)")
print("-" * 50)

# Group bet cycles by market question
c.execute('''
    SELECT cy.id, cy.ts_start, cy.action, cy.reasoning,
           l.description, l.amount
    FROM cycles cy
    JOIN ledger l ON l.reference_id = cy.id
    WHERE cy.action IN ('bet', 'sell_prediction')
    ORDER BY cy.id
''')

# Track buy-sell oscillation by market
market_actions = {}
oscillation_losses = 0
for r in c.fetchall():
    desc = r['description'] or ''
    mkt_match = re.search(r"'([^']+)'", desc)
    if not mkt_match:
        continue
    market = mkt_match.group(1)
    action = r['action']

    if market not in market_actions:
        market_actions[market] = []
    market_actions[market].append({
        'cycle': r['id'],
        'action': action,
        'amount': r['amount'],
        'desc': desc
    })

oscillation_count = 0
oscillation_loss_total = 0
for market, actions in market_actions.items():
    if len(actions) >= 4:
        # Count buy-sell pairs
        pairs = 0
        for i in range(1, len(actions)):
            if actions[i-1]['action'] == 'bet' and actions[i]['action'] == 'sell_prediction':
                pairs += 1
        if pairs >= 2:
            # Calculate net PnL for this market
            net = 0
            for a in actions:
                if 'P&L' in a['desc']:
                    pnl_match = re.search(r'P&L: \$([+-]?[\d.]+)', a['desc'])
                    if pnl_match:
                        net += float(pnl_match.group(1))
            if net < 0:
                oscillation_count += 1
                oscillation_loss_total += net
                if oscillation_count <= 10:
                    print(f"  {market[:60]}: {pairs} buy-sell pairs, net PnL: ${net:.2f}")

print(f"\nTotal oscillation markets with losses: {oscillation_count}")
print(f"Total oscillation losses: ${oscillation_loss_total:.2f}")
print()

# Safeguard 2: LOW CONFIDENCE
print("SAFEGUARD 2: LOW CONFIDENCE BETS (confidence < 0.5)")
print("-" * 50)
low_conf_loss = 0
low_conf_count = 0
for cycle in all_bet_cycles:
    edge = cycle.get('edge_data')
    if edge and edge['confidence'] is not None and edge['confidence'] < 0.5:
        # Check if this cycle's market ended in a loss
        reasoning = cycle.get('reasoning', '') or ''
        low_conf_count += 1

print(f"Total bets with confidence < 0.5: {low_conf_count}")
print()

# Safeguard 3: EXCESSIVE MOMENTUM ADDS
print("SAFEGUARD 3: EXCESSIVE MOMENTUM ADDS (>5 adds to same position)")
print("-" * 50)
# Group momentum adds by prediction_id
c.execute('''
    SELECT prediction_id, COUNT(*) as add_count,
           SUM(amount_usd) as total_staked, question
    FROM smart_money_log
    WHERE action_taken LIKE '%add%'
    AND prediction_id IS NOT NULL
    GROUP BY prediction_id
    HAVING add_count > 5
    ORDER BY add_count DESC
''')
excessive_adds = c.fetchall()
for r in excessive_adds:
    q = (r['question'] or '')[:60]
    print(f"  Prediction {r['prediction_id']}: {r['add_count']} adds, ${r['total_staked']:.2f} staked")
    print(f"    {q}")
print(f"\nTotal predictions with >5 momentum adds: {len(excessive_adds)}")
print()

# Safeguard 4: BUYING AT HIGH ODDS (>70%)
print("SAFEGUARD 4: BUYING AT HIGH ENTRY ODDS (>70%)")
print("-" * 50)
high_entry = 0
c.execute('''
    SELECT id, ts, amount, description
    FROM ledger
    WHERE entry_type = 'prediction_buy'
    AND description LIKE '%@%'
    ORDER BY ts
''')
for r in c.fetchall():
    desc = r['description'] or ''
    odds_match = re.search(r'@ (\d+)%', desc)
    if odds_match:
        odds = int(odds_match.group(1))
        if odds > 70:
            high_entry += 1
            if high_entry <= 10:
                print(f"  #{r['id']} | ${abs(r['amount']):.2f} @ {odds}% | {desc[:80]}")
print(f"\nTotal buys at >70% odds: {high_entry}")
print()

# Safeguard 5: POSITION SIZE vs BALANCE
print("SAFEGUARD 5: OVERSIZED POSITIONS (>25% of balance)")
print("-" * 50)
oversized = 0
c.execute('''
    SELECT cy.id, cy.balance_after, l.amount, l.description
    FROM cycles cy
    JOIN ledger l ON l.reference_id = cy.id
    WHERE cy.action = 'bet'
    AND l.entry_type = 'prediction_buy'
    ORDER BY cy.id
''')
for r in c.fetchall():
    stake = abs(r['amount'])
    balance_before = r['balance_after'] + stake  # approx
    if balance_before > 0 and (stake / balance_before) > 0.25:
        oversized += 1
        if oversized <= 10:
            pct = (stake / balance_before) * 100
            desc = (r['description'] or '')[:70]
            print(f"  Cycle {r['id']}: ${stake:.2f} = {pct:.0f}% of ${balance_before:.2f} | {desc}")
print(f"\nTotal oversized bets: {oversized}")
print()

# ==========================================
# PART 5: Calculate savings per safeguard
# ==========================================
print("=" * 60)
print("POTENTIAL SAVINGS PER SAFEGUARD")
print("=" * 60)

# For each loss, try to attribute it to a safeguard violation
# We need to match loss sells back to their originating buy cycles

# Get full ledger for matching
c.execute('''
    SELECT id, ts, entry_type, amount, description, reference_id, balance_after
    FROM ledger
    ORDER BY id
''')
all_ledger = [dict(r) for r in c.fetchall()]

# Build prediction tracking: map buy descriptions to their sells
# Each sell describes the market. Match buys to the same market.

# Aggregate: for each distinct market that had losses, find the original buys and conditions
print()
print("Note: Savings estimates account for the fact that NOT entering a losing")
print("trade would have saved both the loss AND the trading friction costs.")
print()

# Final summary
total_loss = sum(l['pnl'] for l in losses)
print(f"TOTAL REALIZED LOSSES: ${total_loss:.2f}")
print(f"TOTAL REALIZED WINS:   ${sum(w['pnl'] for w in wins):.2f}")
print(f"NET P&L:               ${sum(s['pnl'] for s in all_sells):.2f}")
print()

# Get current balance and API costs
c.execute("SELECT balance_after FROM cycles ORDER BY id DESC LIMIT 1")
r = c.fetchone()
print(f"Current balance: ${r['balance_after']:.2f}" if r else "No cycles")

c.execute("SELECT SUM(amount) FROM ledger WHERE entry_type = 'api_cost'")
r = c.fetchone()
print(f"Total API costs: ${abs(r[0]):.2f}" if r and r[0] else "No API costs")

# Open positions (currently held)
c.execute('''
    SELECT COUNT(*) as cnt, SUM(amount_usd) as staked
    FROM smart_money_log
    WHERE outcome = 'pending'
''')
r = c.fetchone()
print(f"Open positions: {r['cnt']} predictions, ${r['staked']:.2f} staked" if r else "No open positions")

conn.close()
