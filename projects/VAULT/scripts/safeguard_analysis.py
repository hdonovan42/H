#!/usr/bin/env python3
"""Analyze VAULT trading history for safeguard effectiveness."""
import sqlite3
import re

conn = sqlite3.connect('vault.db')
conn.row_factory = sqlite3.Row
c = conn.cursor()

# Extract P&L from sell descriptions
c.execute('''
    SELECT id, ts, amount, description, balance_after
    FROM ledger
    WHERE entry_type = 'prediction_sell'
    ORDER BY ts
''')

total_pnl = 0
losses = []
wins = []
flat = []

for r in c.fetchall():
    desc = r['description'] or ''
    # Match P&L: $+48.64 or P&L: $-3.39
    match = re.search(r'P&L: \$([+-]?[\d.]+)', desc)
    if match:
        pnl = float(match.group(1))
        total_pnl += pnl
        entry = {
            'id': r['id'],
            'ts': r['ts'],
            'sell_amount': r['amount'],
            'pnl': pnl,
            'desc': desc[:130]
        }
        if pnl < -0.01:
            losses.append(entry)
        elif pnl > 0.01:
            wins.append(entry)
        else:
            flat.append(entry)

print(f'Total realized PnL from sells: ${total_pnl:.2f}')
print(f'Win count: {len(wins)}, Loss count: {len(losses)}, Flat: {len(flat)}')
print(f'Total win amount: ${sum(w["pnl"] for w in wins):.2f}')
print(f'Total loss amount: ${sum(l["pnl"] for l in losses):.2f}')
print()

# Sort losses by magnitude
losses.sort(key=lambda x: x['pnl'])
print(f'=== ALL {len(losses)} LOSING TRADES (sorted worst first) ===')
for l in losses:
    print(f'  #{l["id"]} | pnl=${l["pnl"]:.2f} | sell=${l["sell_amount"]:.2f} | {l["ts"]}')
    print(f'    {l["desc"]}')
    print()

# Now look at corresponding buy cycles to understand entry conditions
print('=== ENTRY CONDITIONS FOR LOSING TRADES ===')
for l in losses:
    desc = l['desc']
    # Extract market name
    market_match = re.search(r"'([^']+)'", desc)
    market = market_match.group(1) if market_match else 'unknown'

    # Find the buy entries for the same market
    c.execute('''
        SELECT id, ts, amount, description
        FROM ledger
        WHERE entry_type = 'prediction_buy'
        AND description LIKE ?
        ORDER BY ts
    ''', (f'%{market[:40]}%',))
    buys = c.fetchall()

    print(f'Loss: ${l["pnl"]:.2f} on "{market[:60]}"')
    print(f'  Sell: #{l["id"]} @ {l["ts"]} for ${l["sell_amount"]:.2f}')
    total_cost = sum(abs(b['amount']) for b in buys)
    print(f'  Total bought: ${total_cost:.2f} across {len(buys)} buys')
    for b in buys[:3]:
        bdesc = (b['description'] or '')[:100]
        print(f'    Buy #{b["id"]}: ${abs(b["amount"]):.2f} - {bdesc}')
    if len(buys) > 3:
        print(f'    ... and {len(buys) - 3} more buys')
    print()

print('\n=== TOP 20 WINNERS ===')
wins.sort(key=lambda x: -x['pnl'])
for w in wins[:20]:
    print(f'  #{w["id"]} | pnl=+${w["pnl"]:.2f} | sell=${w["sell_amount"]:.2f} | {w["ts"]}')
    print(f'    {w["desc"]}')
    print()

# Now get the FULL picture: smart_money_log with all details
print('\n=== SMART MONEY LOG SUMMARY ===')
c.execute('SELECT COUNT(*) as cnt FROM smart_money_log')
print(f'Total entries: {c.fetchone()["cnt"]}')

c.execute('''
    SELECT action_taken, COUNT(*) as cnt,
           SUM(COALESCE(amount_usd, 0)) as total_amount
    FROM smart_money_log
    GROUP BY action_taken
''')
for r in c.fetchall():
    print(f'  {r["action_taken"]}: {r["cnt"]} entries, total=${r["total_amount"]:.2f}')

# Get the cycles that resulted in bet actions and check their edge calculations
print('\n=== EDGE ANALYSIS OF BET CYCLES ===')
c.execute('''
    SELECT ec.cycle_id, ec.market_id, ec.vault_prob, ec.market_odds, ec.edge,
           ec.side, ec.confidence, ec.recommended_size_usd, ec.action,
           cy.balance_after, cy.reasoning
    FROM edge_calculations ec
    JOIN cycles cy ON ec.cycle_id = cy.id
    WHERE cy.action = 'bet'
    ORDER BY ec.cycle_id
    LIMIT 20
''')
for r in c.fetchall():
    print(f'  Cycle {r["cycle_id"]} | edge={r["edge"]:.1%} | vault={r["vault_prob"]} | mkt={r["market_odds"]} | side={r["side"]} | conf={r["confidence"]}')
    print(f'    rec_size=${r["recommended_size_usd"]:.2f} | action={r["action"]} | bal=${r["balance_after"]:.2f}')
    print()

conn.close()
