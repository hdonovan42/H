"""System prompt builder — survival-framed context for VAULT agent."""

from datetime import datetime, timezone, timedelta
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

OPEN PREDICTIONS:
"""

    predictions = ledger.get_open_predictions(conn)
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


def build_momentum_prompt(question: str, v_1h: float | None, v_6h: float | None,
                          market_odds: float, side: str, entry_price: float,
                          remaining: float, z_1h: float | None = None,
                          market_context: dict | None = None) -> tuple[str, str]:
    """Build prompt for Haiku momentum validation — follow/no-follow on a sharp move.

    Direction and sizing are determined mechanically before this call.
    Haiku's job is to validate: "should we follow this momentum?"

    Returns (system_prompt, user_prompt) tuple.
    """
    system = (
        "You are a momentum signal validator for a prediction market trading bot. "
        "The default action is FOLLOW — sharp price moves on live events are usually right. "
        "Only reject if there is a CLEAR reason not to follow. "
        "Respond ONLY with valid JSON: "
        '{"follow": true, "confidence": 0.8, "reasoning": "..."}'
    )

    vel_parts = []
    if v_1h is not None:
        vel_parts.append(f"{v_1h:+.0%}/1h")
    if v_6h is not None:
        vel_parts.append(f"{v_6h:+.0%}/6h")
    if z_1h is not None:
        vel_parts.append(f"z-score={z_1h:.1f} (move significance vs 24h baseline)")
    vel_desc = ", ".join(vel_parts)

    user = (
        f'Market: "{question}"\n'
        f'Current odds: {market_odds:.0%} YES / {1 - market_odds:.0%} NO\n'
        f'Velocity: {vel_desc}\n'
        f'Proposed bet: {side} at {entry_price:.0%} (remaining upside: {remaining:.0%})\n'
    )

    now_utc = datetime.now(timezone.utc)
    user += f'Current time: {now_utc.strftime("%Y-%m-%d %H:%M UTC")}\n\n'

    # Add market context if available
    if market_context:
        ctx_parts = []
        desc = market_context.get("description", "")
        if desc:
            ctx_parts.append(f"Resolution: {desc[:200]}")
        event_title = market_context.get("event_title", "")
        if event_title:
            ctx_parts.append(f"Event: {event_title}")
        game_start = market_context.get("game_start_time", "")
        if game_start:
            try:
                gs = datetime.fromisoformat(str(game_start))
                diff_h = (now_utc - gs).total_seconds() / 3600
                if -1 <= diff_h <= 6:
                    status = f"LIVE — started {diff_h:.1f}h ago"
                elif diff_h < -1:
                    status = f"starts in {-diff_h:.0f}h"
                else:
                    status = f"started {diff_h:.0f}h ago (likely finished)"
                ctx_parts.append(f"Game: {status}")
            except (ValueError, TypeError):
                ctx_parts.append(f"Game starts: {game_start}")
        vol24 = market_context.get("volume_24h", 0) or 0
        liq = market_context.get("liquidity", 0) or 0
        if vol24 or liq:
            ctx_parts.append(f"24h volume: ${vol24:,.0f}, Liquidity: ${liq:,.0f}")
        spread = market_context.get("spread", 0) or 0
        if spread:
            ctx_parts.append(f"Spread: {spread:.0%}")
        if ctx_parts:
            user += "Market context:\n" + "\n".join(f"- {p}" for p in ctx_parts) + "\n\n"

    user += (
        f'The DEFAULT is follow=true. Only set follow=false if:\n'
        f'- The market is clearly already settled (event over, result known)\n'
        f'- The move is obviously manipulative (tiny market, no possible catalyst)\n'
        f'- The entry price is so extreme there is negligible upside\n\n'
        f'Live sports, esports, and breaking news moves should almost always be followed.\n\n'
        f'JSON only: {{"follow": true/false, "confidence": 0.0-1.0, "reasoning": "one sentence"}}'
    )

    return system, user


def _format_velocity_line(item: dict) -> str:
    """Format a velocity line for prompts. Returns empty string if no velocity data."""
    v_1h = item.get("v_1h")
    v_6h = item.get("v_6h")
    if v_1h is None and v_6h is None:
        return ""

    parts = []
    if v_1h is not None:
        parts.append(f"{v_1h:+.0%}/1h")
    if v_6h is not None:
        parts.append(f"{v_6h:+.0%}/6h")

    direction = item.get("velocity_direction", "neutral")
    sharp = item.get("velocity_sharp", False)
    if sharp and direction == "away":
        suffix = " SMART MONEY VETOED (bet blocked)"
    elif sharp and direction == "toward":
        suffix = " SMART MONEY CONFIRMS (boosted confidence)"
    elif direction == "toward":
        suffix = " (market moving toward your estimate)"
    elif direction == "away":
        suffix = " (market moving AWAY — caution)"
    else:
        suffix = ""

    return f"Velocity: {', '.join(parts)}{suffix}"
