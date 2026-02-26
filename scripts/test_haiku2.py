"""Test Haiku prompt for the ETH dip market — call API directly."""
import sqlite3, sys, os, json
sys.path.insert(0, '/home/hq/vault')

from vault.prompts import build_momentum_prompt
from vault.db import init_db
import anthropic

conn = init_db()

# Find the correct ETH market
mkts = conn.execute("""
    SELECT market_id, question, end_date, description, volume_24h, liquidity, spread,
           game_start_time, event_title
    FROM musk_markets WHERE question LIKE '%Ethereum%dip%1,900%'
""").fetchall()

if not mkts:
    # Try broader search
    mkts = conn.execute("""
        SELECT market_id, question, end_date, description, volume_24h, liquidity, spread,
               game_start_time, event_title
        FROM musk_markets WHERE question LIKE '%Ethereum%1,900%'
    """).fetchall()

for m in mkts:
    print(f"Found: {m['question']} (ends: {m['end_date']})")

if not mkts:
    print("No ETH market found")
    sys.exit(1)

mkt = mkts[0]
market_context = dict(mkt)

system, user = build_momentum_prompt(
    question=mkt['question'],
    v_1h=-0.17,
    v_6h=None,
    market_odds=0.68,
    side="NO",
    entry_price=0.32,
    remaining=2.125,
    z_1h=-6.0,
    market_context=market_context,
)

print(f"\n=== USER PROMPT ===\n{user}")

# Call Haiku directly
client = anthropic.Anthropic()
resp = client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=256,
    system=system,
    messages=[{"role": "user", "content": user}],
)
text = resp.content[0].text
print(f"\n=== HAIKU RESPONSE ===\n{text}")

# Also test BTC
print("\n\n=== NOW TESTING BTC ===")
btc_mkts = conn.execute("""
    SELECT market_id, question, end_date, description, volume_24h, liquidity, spread,
           game_start_time, event_title
    FROM musk_markets WHERE question LIKE '%Bitcoin%dip%64,000%'
""").fetchall()
if not btc_mkts:
    btc_mkts = conn.execute("""
        SELECT market_id, question, end_date, description, volume_24h, liquidity, spread,
               game_start_time, event_title
        FROM musk_markets WHERE question LIKE '%Bitcoin%64,000%'
    """).fetchall()

for m in btc_mkts:
    print(f"Found: {m['question']} (ends: {m['end_date']})")

if btc_mkts:
    mkt2 = btc_mkts[0]
    sys2, usr2 = build_momentum_prompt(
        question=mkt2['question'],
        v_1h=-0.15,
        v_6h=None,
        market_odds=0.31,
        side="NO",
        entry_price=0.69,
        remaining=0.449,
        z_1h=-5.8,
        market_context=dict(mkt2),
    )
    print(f"\n=== USER PROMPT ===\n{usr2}")
    resp2 = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=256,
        system=sys2,
        messages=[{"role": "user", "content": usr2}],
    )
    print(f"\n=== HAIKU RESPONSE ===\n{resp2.content[0].text}")
