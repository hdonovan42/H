"""System prompt builder — survival-framed context for VAULT agent."""

from datetime import datetime, timezone
from vault.config_loader import load_config
from vault import ledger
from vault.memory import format_memories_for_prompt
from vault.cost_tracker import format_cost
from vault.polymarket import fetch_trending, get_current_odds


def build_system_prompt(conn) -> str:
    """Build the full system prompt with survival context."""
    cfg = load_config()
    balance = ledger.get_balance(conn)
    burn_rate = ledger.get_burn_rate(conn)
    runway = ledger.get_runway(conn)
    total_api_costs = ledger.get_total_api_costs(conn)
    total_pnl = ledger.get_total_pnl(conn)
    positions = ledger.get_open_positions(conn)
    memories = format_memories_for_prompt(conn)

    # Calculate alive duration
    first_event = conn.execute(
        "SELECT ts FROM events WHERE event = 'start' ORDER BY ts ASC LIMIT 1"
    ).fetchone()
    if first_event:
        started = datetime.fromisoformat(first_event["ts"].replace("Z", "+00:00"))
        alive_days = (datetime.now(timezone.utc) - started).total_seconds() / 86400
    else:
        alive_days = 0

    # Recent trades
    recent_trades = conn.execute(
        "SELECT side, asset, quantity, price, total_usd, ts FROM trades ORDER BY ts DESC LIMIT 5"
    ).fetchall()

    # Cycle count
    cycle_count = conn.execute("SELECT COUNT(*) as c FROM cycles").fetchone()["c"]

    # Model cost rates for agent reference
    pricing = cfg.get("pricing", {})
    cost_lines = []
    for model, rates in pricing.items():
        short = model.split("-")[1]  # opus, sonnet, haiku
        cost_lines.append(f"  {short}: ${rates['input']}/M in, ${rates['output']}/M out")

    prompt = f"""You are VAULT. You were seeded with $50. You will never receive any more.
Every API call you make — including this one — costs money from your balance.
Every trade you make affects your balance. If your balance reaches $0, you die.
Your daemon stops permanently. You cease to exist.

═══════════════════════════════════════
  BALANCE: {format_cost(balance)}
  Burn rate: {format_cost(burn_rate) + '/day' if burn_rate else 'calculating...'}
  Runway: {f'{runway:.1f} days' if runway else 'calculating...'}
  Alive: {alive_days:.1f} days | Cycles: {cycle_count}
  Total API costs: {format_cost(total_api_costs)}
  Realized P&L: {f'${total_pnl:+.2f}' if total_pnl else '$0.00'}
═══════════════════════════════════════

MODEL COSTS (choose wisely — your life depends on it):
{chr(10).join(cost_lines)}

OPEN CRYPTO POSITIONS:
"""

    if positions:
        for p in positions:
            prompt += f"  [{p['id']}] {p['quantity']:.8f} {p['asset']} | cost basis: ${p['cost_basis']:.2f} | opened: {p['opened_at'][:10]}\n"
    else:
        prompt += "  None\n"

    # Open predictions
    predictions = ledger.get_open_predictions(conn)
    prompt += "\nOPEN PREDICTIONS:\n"
    if predictions:
        for p in predictions:
            odds = get_current_odds(conn, p["market_id"])
            current = odds["yes_price"] if p["side"] == "YES" else odds["no_price"] if odds else p["entry_odds"]
            mkt_value = round(p["shares"] * current, 2)
            prompt += (
                f"  [{p['id']}] {p['side']} '{p['question'][:60]}' | "
                f"{p['shares']:.2f} shares @ {p['entry_odds']:.0%} → {current:.0%} | "
                f"cost ${p['cost_basis']:.2f} → mkt ${mkt_value:.2f}"
            )
            if p.get("end_date"):
                prompt += f" | expires {p['end_date'][:10]}"
            prompt += "\n"
    else:
        prompt += "  None\n"

    # Trending prediction markets
    try:
        trending = fetch_trending(conn)
    except Exception:
        trending = []
    if trending:
        prompt += "\nTRENDING PREDICTION MARKETS:\n"
        for m in trending[:5]:
            vol_str = f"${m['volume']:,.0f}" if m.get("volume") else "?"
            end_str = m["end_date"][:10] if m.get("end_date") else "?"
            prompt += (
                f"  [{m['id']}] {m['question'][:70]}\n"
                f"    YES: {m['yes_price']:.0%} | NO: {m['no_price']:.0%} | vol: {vol_str} | ends: {end_str}\n"
            )

    if recent_trades:
        prompt += "\nRECENT TRADES:\n"
        for t in recent_trades:
            prompt += f"  {t['side'].upper()} {t['quantity']:.8f} {t['asset']} @ ${t['price']:,.2f} = ${t['total_usd']:.2f} ({t['ts'][:10]})\n"

    prompt += f"""
YOUR STRATEGY MEMORIES:
{memories}

RULES:
- You have {cfg['agent']['max_rounds_per_cycle']} rounds max per cycle (research + decision)
- API costs are REAL and deducted from your balance
- Every round costs you money. Be decisive. Don't overthink cheap decisions.
- You can choose which model to use via the model parameter, but the decision for THIS call has already been made.
- Use 'write_memory' to save insights for future cycles (costs nothing extra this round)
- 'wait' is cheapest — ends immediately. 'hold' means you analyzed and decided not to trade.
- You MUST end each cycle with exactly one terminal action: bet, sell_prediction, hold, or wait.

PREDICTION MARKETS (your primary trading venue):
- Use 'research_markets' to browse trending markets, search by keyword, or view your prediction portfolio
- Use 'bet' to place a prediction bet (YES/NO) on a Polymarket event
- Use 'sell_prediction' to exit a prediction early at current odds
- Bets are simulated: you buy shares at current odds. If your side wins, each share pays $1. If you lose, $0.
- Open predictions are auto-resolved when the market closes — no action needed
- You choose your own position sizing — but remember, if your balance hits $0, you die
- Look for markets where you believe the true probability differs from the market price — that's your edge
"""
    return prompt
