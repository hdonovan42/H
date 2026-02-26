"""Manually test what Haiku says about the ETH market."""
import sqlite3, sys, os
sys.path.insert(0, '/home/hq/vault')

from vault.prompts import build_momentum_prompt
from vault.claude_client import call_claude
from vault import ledger
from vault.db import init_db

conn = init_db()

# Get ETH market data
mkt = conn.execute("""
    SELECT market_id, question, end_date, description, volume_24h, liquidity, spread,
           competitive, game_start_time, event_title
    FROM musk_markets WHERE question LIKE '%Ethereum%1,900%'
    LIMIT 1
""").fetchone()

if not mkt:
    print("ETH market not found")
    sys.exit(1)

print(f"Market: {mkt['question']}")
print(f"Market ID: {mkt['market_id']}")

# Build the prompt exactly as the agent would
market_context = dict(mkt)
system, user = build_momentum_prompt(
    question=mkt['question'],
    v_1h=-0.17,
    v_6h=None,
    market_odds=0.68,
    side="NO",
    entry_price=0.32,
    remaining=2.125,  # (1-0.32)/0.32
    z_1h=-6.0,
    market_context=market_context,
)

print("\n=== SYSTEM PROMPT ===")
print(system)
print("\n=== USER PROMPT ===")
print(user)

# Call Haiku
print("\n=== CALLING HAIKU ===")
response = call_claude(
    conn=conn,
    ledger_mod=ledger,
    model="claude-haiku-4-5-20251001",
    system=system,
    messages=[{"role": "user", "content": user}],
    cycle_id=0,
    purpose="test_momentum",
    max_tokens=256,
)
text = " ".join(b["text"] for b in response["content"] if b["type"] == "text")
print(f"\n=== HAIKU RESPONSE ===")
print(text)
print(f"\nCost: ${response.get('cost', 0):.4f}")
