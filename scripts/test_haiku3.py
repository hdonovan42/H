"""Test updated Haiku prompt for ETH and BTC markets."""
import sqlite3, sys, os
sys.path.insert(0, '/home/hq/vault')

# Reload the module to pick up changes
import importlib
import vault.prompts
importlib.reload(vault.prompts)
from vault.prompts import build_momentum_prompt
from vault.db import init_db
import anthropic

conn = init_db()
client = anthropic.Anthropic()

# ETH market
mkt = conn.execute("""
    SELECT * FROM musk_markets WHERE question LIKE '%Ethereum%dip%1,900%' LIMIT 1
""").fetchone()

if mkt:
    print(f"=== ETH: {mkt['question']} ===")
    system, user = build_momentum_prompt(
        question=mkt['question'], v_1h=-0.17, v_6h=None,
        market_odds=0.68, side="NO", entry_price=0.32, remaining=2.125,
        z_1h=-6.0, market_context=dict(mkt),
    )
    print(f"PROMPT:\n{user}\n")
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001", max_tokens=256,
        system=system, messages=[{"role": "user", "content": user}],
    )
    print(f"RESPONSE: {resp.content[0].text}\n")

# BTC market
mkt2 = conn.execute("""
    SELECT * FROM musk_markets WHERE question LIKE '%Bitcoin%dip%64,000%' LIMIT 1
""").fetchone()

if mkt2:
    print(f"=== BTC: {mkt2['question']} ===")
    system2, user2 = build_momentum_prompt(
        question=mkt2['question'], v_1h=-0.15, v_6h=None,
        market_odds=0.31, side="NO", entry_price=0.69, remaining=0.449,
        z_1h=-5.8, market_context=dict(mkt2),
    )
    print(f"PROMPT:\n{user2}\n")
    resp2 = client.messages.create(
        model="claude-haiku-4-5-20251001", max_tokens=256,
        system=system2, messages=[{"role": "user", "content": user2}],
    )
    print(f"RESPONSE: {resp2.content[0].text}\n")
