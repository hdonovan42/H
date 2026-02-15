"""System prompt builder — survival-framed context for VAULT agent."""

from datetime import datetime, timezone
from vault.config_loader import load_config
from vault import ledger
from vault.memory import format_memories_for_prompt
from vault.cost_tracker import format_cost
from vault.polymarket import fetch_trending, get_current_odds


def build_decider_prompt(conn, pipeline_result, actionable: list[dict]) -> tuple[str, str]:
    """Build focused prompt for single-shot decider. No tools, JSON response only.

    Returns (system_prompt, user_prompt) tuple.
    """
    balance = ledger.get_balance(conn)
    burn_rate = ledger.get_burn_rate(conn)
    runway = ledger.get_runway(conn)

    system = (
        "You are a prediction market trader making quick decisions on pre-analysed opportunities. "
        "Respond ONLY with a valid JSON array. No explanation, no markdown, just JSON."
    )

    header = f"You are VAULT. Balance: ${balance:.2f}"
    if burn_rate:
        header += f" | Burn: ${burn_rate:.2f}/day"
    if runway:
        header += f" | Runway: {runway:.0f} days"

    body = f"{header}\n\nThe pipeline found these opportunities requiring your decision:\n"

    for item in actionable:
        action = item.get("action")

        if action == "bet":
            vel_line = _format_velocity_line(item)
            body += f"""
═══ BET OPPORTUNITY ═══
  "{item.get('question', item.get('market_id', '?'))[:80]}"
  YOUR estimate: {item.get('vault_prob', 0):.0%} {item.get('side', 'YES')} (confidence: {item.get('confidence', 0):.1f})
  Market odds:   {item.get('market_odds', 0):.0%} YES
  Edge:          {item.get('edge', 0):+.0%} → BET {item.get('side', 'YES')}
  Recommended:   ${item.get('recommended_size_usd', 0):.2f} (Kelly-adjusted)
  Market ID:     {item.get('market_id', '?')}
"""
            if vel_line:
                body += f"  {vel_line}\n"

        elif action == "exit":
            pred_id = item.get("prediction_id", "?")
            reason = item.get("reasoning", "thesis concern")
            source = item.get("source", "edge_calc")
            vel_line = _format_velocity_line(item)
            body += f"""
═══ EXIT SIGNAL ═══
  Position [{pred_id}]: {reason}
  Source: {source}
  → SELL IMMEDIATELY
"""
            if vel_line:
                body += f"  {vel_line}\n"

    body += """
Respond with a JSON array of actions:
[{"action": "bet", "market_id": "ID", "side": "YES", "amount_usd": 5.00, "reasoning": "..."}]
or
[{"action": "sell", "prediction_id": 89, "reasoning": "..."}]
or
[{"action": "hold", "reasoning": "..."}]

You may act on multiple opportunities. You may override any recommendation with "hold" if you disagree.
Rules: One bet or sell per cycle. If you want to act on multiple, pick the highest-quality one."""

    return system, body


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


def build_edge_prompt(conn, pipeline_result) -> str:
    """Build system prompt with edge analysis from pipeline. Replaces build_system_prompt when pipeline is active.

    Shows the agent pre-computed edge analysis so it can make informed decisions
    without needing to research markets itself.
    """
    cfg = load_config()
    balance = ledger.get_balance(conn)
    burn_rate = ledger.get_burn_rate(conn)
    runway = ledger.get_runway(conn)
    total_api_costs = ledger.get_total_api_costs(conn)
    total_pnl = ledger.get_total_pnl(conn)
    memories = format_memories_for_prompt(conn)

    # Alive duration
    first_event = conn.execute(
        "SELECT ts FROM events WHERE event = 'start' ORDER BY ts ASC LIMIT 1"
    ).fetchone()
    if first_event:
        started = datetime.fromisoformat(first_event["ts"].replace("Z", "+00:00"))
        alive_days = (datetime.now(timezone.utc) - started).total_seconds() / 86400
    else:
        alive_days = 0

    cycle_count = conn.execute("SELECT COUNT(*) as c FROM cycles").fetchone()["c"]

    prompt = f"""You are VAULT. You were seeded with $50. You will never receive any more.
Every API call you make — including this one — costs money from your balance.
Every trade you make affects your balance. If your balance reaches $0, you die.

═══════════════════════════════════════
  BALANCE: {format_cost(balance)}
  Burn rate: {format_cost(burn_rate) + '/day' if burn_rate else 'calculating...'}
  Runway: {f'{runway:.1f} days' if runway else 'calculating...'}
  Alive: {alive_days:.1f} days | Cycles: {cycle_count}
  Total API costs: {format_cost(total_api_costs)}
  Realized P&L: {f'${total_pnl:+.2f}' if total_pnl else '$0.00'}
═══════════════════════════════════════
"""

    # ── Master Intelligence Document ──
    if pipeline_result and pipeline_result.digest:
        prompt += "\n═══ MASTER INTELLIGENCE ═══\n"
        prompt += pipeline_result.digest + "\n"

    # ── Actionable Themes ──
    if pipeline_result and pipeline_result.themes:
        prompt += "\n═══ ACTIONABLE THEMES ═══\n"
        for t in pipeline_result.themes:
            edge_type = t.get("edge_type", "event")
            keywords = ", ".join(t.get("keywords", []))
            prompt += f"  [{edge_type.upper()}] {t.get('theme', '')} — keywords: {keywords}\n"
        prompt += "\n"

    # ── Sentinel Alerts ──
    sentinel = pipeline_result.sentinel_results if pipeline_result else {}
    broken_alerts = [a for a in sentinel.get("position_alerts", []) if a.get("status") == "BROKEN"]
    if broken_alerts:
        prompt += "\n═══ SENTINEL ALERTS ═══\n"
        for alert in broken_alerts:
            prompt += f"  BREAKING: Position [{alert['prediction_id']}] thesis broken\n"
            if alert.get("event"):
                prompt += f"    Event: {alert['event']}\n"
            if alert.get("source"):
                prompt += f"    Source: {alert['source']}\n"
            prompt += "    → SELL IMMEDIATELY\n\n"

    if sentinel.get("major_event"):
        event = sentinel["major_event"]
        prompt += "\n═══ MAJOR EVENT DETECTED ═══\n"
        prompt += f"  {event['event']}\n"
        if event.get("source"):
            prompt += f"  Source: {event['source']}\n"
        prompt += "  (Emergency Opus re-estimation triggered)\n\n"

    # ── Edge Analysis Section ──
    edges = pipeline_result.edges if pipeline_result else []
    bet_edges = [e for e in edges if e["action"] == "bet"]
    hold_edges = [e for e in edges if e["action"] == "hold" and not e.get("is_open_position")]
    exit_edges = [e for e in edges if e["action"] == "exit"]

    if bet_edges or hold_edges or exit_edges:
        prompt += "\n═══ EDGE ANALYSIS ═══\n"
        prompt += "The pipeline has independently estimated probabilities (blind to market odds) and found:\n\n"

        for e in bet_edges:
            arrow = "→ BET " + e["side"]
            vel_line = _format_velocity_line(e)
            prompt += (
                f"  Market: \"{e.get('question', e['market_id'])[:70]}\"\n"
                f"    YOUR estimate: {e['vault_prob']:.0%} YES (confidence: {e['confidence']:.1f})\n"
                f"    Market odds:   {e['market_odds']:.0%} YES\n"
                f"    Edge:          {e['edge']:+.0%} {arrow}\n"
                f"    Recommended:   ${e['recommended_size_usd']:.2f} (Kelly-adjusted)\n"
                f"    Market ID:     {e['market_id']}\n"
            )
            if vel_line:
                prompt += f"    {vel_line}\n"
            prompt += "\n"

        for e in hold_edges:
            vel_line = _format_velocity_line(e)
            prompt += (
                f"  Market: \"{e.get('question', e['market_id'])[:70]}\"\n"
                f"    YOUR estimate: {e['vault_prob']:.0%} YES (confidence: {e['confidence']:.1f})\n"
                f"    Market odds:   {e['market_odds']:.0%} YES\n"
                f"    Edge:          {e['edge']:+.0%} — {e['reasoning']}\n"
            )
            if vel_line:
                prompt += f"    {vel_line}\n"
            prompt += "\n"

    # ── Open Positions ──
    predictions = ledger.get_open_predictions(conn)
    if predictions or exit_edges:
        prompt += "═══ OPEN POSITIONS ═══\n"

        if predictions:
            for p in predictions:
                odds = get_current_odds(conn, p["market_id"])
                current = odds["yes_price"] if p["side"] == "YES" else odds["no_price"] if odds else p["entry_odds"]
                mkt_value = round(p["shares"] * current, 2)
                pnl = round(mkt_value - p["cost_basis"], 2)

                # Find edge analysis for this position
                pos_edge = next((e for e in edges if e["market_id"] == p["market_id"]), None)

                prompt += (
                    f"  [{p['id']}] {p['side']} \"{p['question'][:60]}\"\n"
                    f"    cost ${p['cost_basis']:.2f} → mkt ${mkt_value:.2f} (P&L: ${pnl:+.2f})\n"
                    f"    entry {p['entry_odds']:.0%} → now {current:.0%}"
                )
                if p.get("end_date"):
                    prompt += f" | expires {p['end_date'][:10]}"
                prompt += "\n"

                # Show entry thesis if available
                if p.get("entry_edge") is not None:
                    prompt += f"    entry edge: {p['entry_edge']:+.0%}"
                    if p.get("entry_reasoning"):
                        prompt += f" — {p['entry_reasoning'][:80]}"
                    prompt += "\n"

                if pos_edge:
                    prompt += (
                        f"    → RECOMMENDATION: {pos_edge['action'].upper()} — {pos_edge['reasoning']}\n"
                    )
                prompt += "\n"
        else:
            prompt += "  None\n\n"

    # ── Opportunity Ranking ──
    actionable = [e for e in edges if e["action"] in ("bet", "exit")]
    if actionable:
        prompt += "═══ OPPORTUNITY RANKING ═══\n"
        for i, e in enumerate(actionable):
            quality = e["abs_edge"] * e["confidence"]
            prompt += (
                f"  {i + 1}. \"{e.get('question', e['market_id'])[:50]}\" "
                f"({e['edge']:+.0%} edge, {e['confidence']:.1f} conf, quality: {quality:.2f}) "
                f"— {e['action'].upper()}"
            )
            if e["action"] == "bet":
                prompt += f" ${e['recommended_size_usd']:.2f}"
            prompt += "\n"
        prompt += "\n"

    # Pipeline stats
    if pipeline_result:
        sentinel_status = "clean"
        if broken_alerts:
            sentinel_status = f"{len(broken_alerts)} BROKEN"
        elif sentinel.get("skipped"):
            sentinel_status = "skipped (no new tweets)"
        prompt += (
            f"Pipeline: {len(pipeline_result.tweets)} tweets, "
            f"{len(pipeline_result.markets)} markets scanned, "
            f"{len(pipeline_result.estimates)} Opus estimates, "
            f"sentinel: {sentinel_status}, "
            f"{len(actionable)} actionable ({pipeline_result.duration_ms}ms)\n\n"
        )

    prompt += f"""YOUR STRATEGY MEMORIES:
{memories}

RULES:
- You have {cfg['agent']['max_rounds_per_cycle']} rounds max per cycle
- The pipeline has already done research and probability estimation — you don't need to call research_markets
- If the edge analysis recommends a bet, you should seriously consider it — the estimate was made blind to market odds
- If it recommends an exit, evaluate whether to sell_prediction
- You can still research_markets if you want to explore beyond the Musk ecosystem
- 'wait' is cheapest. 'hold' means you analyzed and decided not to trade.
- You MUST end each cycle with exactly one terminal action: bet, sell_prediction, hold, or wait.
- Use the market_id from the edge analysis when placing bets

SELL DISCIPLINE — only sell when the thesis is INVALIDATED:
- Probability estimates are from daily Opus analysis (stable across cycles)
- Exit signals come from sentinel thesis monitoring (breaking news) or Opus estimate changes
- The market converging toward your estimate is a WIN, not an exit signal
- Only sell when: sentinel detects thesis break, your estimate flipped against your position, your thesis substantially weakened (< 50% of entry estimate), or remaining EV is negligible
- If a SENTINEL ALERT says SELL IMMEDIATELY — do it, the thesis has been broken by concrete evidence
- DO NOT sell just because the edge narrowed — that means the market agrees with you
- Let winners ride to resolution when the thesis is intact
"""
    return prompt


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
    if direction == "toward":
        suffix = " (market moving toward your estimate)"
    elif direction == "away":
        suffix = " (market moving AWAY — caution)"
    else:
        suffix = ""

    return f"Velocity: {', '.join(parts)}{suffix}"
