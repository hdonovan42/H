"""Agent core — auto-pilot with pipeline-driven decisions. The brain of VAULT."""

import json
import logging
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault.prompts import build_system_prompt, build_momentum_prompt
from vault.actuators import get_tool_schemas, get_actuator, ACTUATOR_MAP
from vault import ledger
from vault.guardrails import check_death, check_cycle_cost, check_trade_allowed, check_drawdown
from vault.polymarket import check_resolution
from vault.pipeline import run_pipeline
from vault.edge_calculator import _log_smart_money_event

log = logging.getLogger("vault.agent")


def resolve_predictions(conn):
    """Check all open predictions for resolution. Called at cycle start."""
    open_preds = ledger.get_open_predictions(conn)
    if not open_preds:
        return

    for pred in open_preds:
        result = check_resolution(conn, pred["market_id"])
        if result and result.get("resolved"):
            winner = result["winner"]
            try:
                pnl = ledger.record_prediction_resolve(conn, pred["id"], winner)
                log.info(
                    f"Auto-resolved prediction {pred['id']} '{pred['question'][:40]}': "
                    f"winner={winner}, side={pred['side']}, P&L=${pnl:+.2f}"
                )
                # Backfill smart money log entries for this market
                _resolve_smart_money_entries(conn, pred, winner, pnl)
                # Resolve any shadow trades for this market
                _resolve_shadow_trades(conn, pred["market_id"], winner)
            except ValueError as e:
                log.warning(f"Failed to resolve prediction {pred['id']}: {e}")


def _resolve_smart_money_entries(conn, pred: dict, winner: str, actual_pnl: float):
    """Backfill outcome on smart_money_log entries when a prediction resolves."""
    try:
        market_id = pred["market_id"]
        rows = conn.execute(
            "SELECT id, action_taken, side, amount_usd, counterfactual_size, counterfactual_side "
            "FROM smart_money_log WHERE market_id = ? AND outcome = 'pending'",
            (market_id,),
        ).fetchall()

        for row in rows:
            action = row["action_taken"]
            now_ts = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

            if action in ("momentum_bet", "momentum_add"):
                # Actual bet was placed — record real P&L
                outcome = "won" if pred["side"] == winner else "lost"
                conn.execute(
                    f"UPDATE smart_money_log SET outcome = ?, outcome_pnl = ?, "
                    f"resolved_at = {now_ts} WHERE id = ?",
                    (outcome, actual_pnl, row["id"]),
                )

            elif action == "boost":
                # Boosted confidence on a bet — record real P&L
                outcome = "won" if pred["side"] == winner else "lost"
                conn.execute(
                    f"UPDATE smart_money_log SET outcome = ?, outcome_pnl = ?, "
                    f"resolved_at = {now_ts} WHERE id = ?",
                    (outcome, actual_pnl, row["id"]),
                )

            elif action == "veto":
                # Compute counterfactual: what WOULD have happened
                cf_side = row["counterfactual_side"]
                cf_size = row["counterfactual_size"] or 0
                if cf_side and cf_size > 0:
                    # If counterfactual side would have won: veto cost us money
                    # If counterfactual side would have lost: veto saved us money
                    if cf_side == winner:
                        # We would have won — veto was wrong
                        outcome = "veto_wrong"
                        cf_pnl = cf_size  # approximate gain we missed
                    else:
                        # We would have lost — veto was correct
                        outcome = "veto_correct"
                        cf_pnl = -cf_size  # loss we avoided
                else:
                    outcome = "veto_correct"
                    cf_pnl = 0

                conn.execute(
                    f"UPDATE smart_money_log SET outcome = ?, counterfactual_pnl = ?, "
                    f"resolved_at = {now_ts} WHERE id = ?",
                    (outcome, cf_pnl, row["id"]),
                )

            elif action == "momentum_skip":
                conn.execute(
                    f"UPDATE smart_money_log SET outcome = 'skipped', "
                    f"resolved_at = {now_ts} WHERE id = ?",
                    (row["id"],),
                )

        if rows:
            conn.commit()
            log.info(f"Resolved {len(rows)} smart money entries for {market_id}")
    except Exception as e:
        log.warning(f"Failed to resolve smart money entries: {e}")



def _resolve_shadow_trades(conn, market_id: str, winner: str):
    """Resolve shadow trades when a market settles."""
    try:
        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows = conn.execute(
            "SELECT id, side, shares, cost_basis FROM shadow_trades "
            "WHERE market_id = ? AND resolved = 0",
            (market_id,),
        ).fetchall()
        for sr in rows:
            won = sr["side"] == winner
            shadow_pnl = (sr["shares"] - sr["cost_basis"]) if won else -sr["cost_basis"]
            conn.execute(
                "UPDATE shadow_trades SET resolved=1, winner=?, shadow_pnl=?, resolved_at=? "
                "WHERE id=?",
                (winner, round(shadow_pnl, 4), now_iso, sr["id"]),
            )
        if rows:
            conn.commit()
            log.info(f"Resolved {len(rows)} shadow trades for {market_id}")
    except Exception as e:
        log.warning(f"Failed to resolve shadow trades: {e}")


def _evaluate_shadow_variants(conn, cfg, *, cycle_id, market_id, question,
                              side, entry_price, raw_bet, unrealised_roi,
                              v_1h, v_6h, z_1h):
    """Log shadow trades for each pyramid variant to A/B test reworked designs."""
    shadow_cfg = cfg.get("shadow_pyramid", {})
    if not shadow_cfg.get("enabled", False):
        return

    from datetime import datetime, timezone, timedelta
    now_utc = datetime.now(timezone.utc)
    variants = shadow_cfg.get("variants", {})

    for name, params in variants.items():
        max_adds = params.get("max_adds", 1)
        p_mult = params.get("pyramid_mult", 1.0)
        min_roi = params.get("min_roi", 0.15)
        cooldown_min = params.get("cooldown_minutes", 30)

        # Check max adds constraint
        existing_count = conn.execute(
            "SELECT COUNT(*) as cnt FROM shadow_trades "
            "WHERE market_id = ? AND side = ? AND variant = ?",
            (market_id, side, name),
        ).fetchone()["cnt"]
        if existing_count >= max_adds:
            continue

        # Check min ROI
        if unrealised_roi < min_roi:
            continue

        # Check cooldown
        last_shadow = conn.execute(
            "SELECT ts FROM shadow_trades "
            "WHERE market_id = ? AND side = ? AND variant = ? "
            "ORDER BY ts DESC LIMIT 1",
            (market_id, side, name),
        ).fetchone()
        if last_shadow and last_shadow["ts"]:
            last_ts = datetime.fromisoformat(last_shadow["ts"].replace("Z", "+00:00"))
            minutes_since = (now_utc - last_ts).total_seconds() / 60
            if minutes_since < cooldown_min:
                continue

        # Compute hypothetical bet size
        shadow_bet = round(raw_bet * p_mult, 2)
        if shadow_bet <= 0 or entry_price <= 0:
            continue
        shadow_shares = round(shadow_bet / entry_price, 4)

        conn.execute(
            "INSERT INTO shadow_trades "
            "(cycle_id, market_id, question, side, variant, entry_price, "
            "shares, cost_basis, pyramid_mult, unrealised_roi, v_1h, v_6h, z_1h) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cycle_id, market_id, question, side, name, entry_price,
             shadow_shares, shadow_bet, p_mult, unrealised_roi,
             v_1h, v_6h, z_1h),
        )
        conn.commit()
        log.info(f"Shadow trade logged: {name} — {side} ${shadow_bet:.2f} "
                 f"on '{question[:40]}' (ROI {unrealised_roi:+.1%})")


def _run_tool_loop(conn, cycle_id, system_prompt, context, cfg) -> dict:
    """Legacy tool-use loop — fallback when pipeline is disabled/failed."""
    max_rounds = cfg["agent"]["max_rounds_per_cycle"]
    messages = [
        {"role": "user", "content": "What is your decision this cycle? Review the trending prediction markets and your open positions."}
    ]
    tools = get_tool_schemas()
    result = {"cycle_id": cycle_id, "action": None, "rounds": 0, "total_cost": 0}

    for round_num in range(1, max_rounds + 1):
        if check_death(conn):
            result["action"] = "death"
            break

        if check_cycle_cost(conn, cycle_id):
            log.warning(f"Cycle {cycle_id} hit cost limit, forcing wait")
            result["action"] = "wait (cost limit)"
            break

        response = call_claude(
            conn=conn,
            ledger_mod=ledger,
            system=system_prompt,
            messages=messages,
            tools=tools,
            cycle_id=cycle_id,
            purpose=f"cycle_{cycle_id}_round_{round_num}",
        )

        result["rounds"] = round_num
        result["total_cost"] += response["cost"]

        if check_death(conn):
            result["action"] = "death"
            break

        tool_calls = [b for b in response["content"] if b["type"] == "tool_use"]
        text_blocks = [b for b in response["content"] if b["type"] == "text"]

        if not tool_calls:
            reasoning = " ".join(b["text"] for b in text_blocks)
            log.warning(f"No tool call in round {round_num}, treating as hold: {reasoning[:100]}")
            result["action"] = "hold"
            result["reasoning"] = reasoning
            break

        tool_call = tool_calls[0]
        actuator = get_actuator(tool_call["name"])

        def _build_tool_results(primary_id, primary_result, all_calls):
            results = []
            for tc in all_calls:
                if tc["id"] == primary_id:
                    results.append({"type": "tool_result", "tool_use_id": tc["id"],
                                    "content": json.dumps(primary_result)})
                else:
                    results.append({"type": "tool_result", "tool_use_id": tc["id"],
                                    "content": json.dumps({"skipped": True, "reason": "Only one tool executed per round"})})
            return results

        if not actuator:
            log.error(f"Unknown tool: {tool_call['name']}")
            messages.append({"role": "assistant", "content": response["content"]})
            messages.append({
                "role": "user",
                "content": _build_tool_results(tool_call["id"], {"error": f"Unknown tool: {tool_call['name']}"}, tool_calls),
            })
            continue

        if tool_call["name"] == "buy":
            allowed, reason = check_trade_allowed(
                conn, tool_call["input"].get("amount_usd", 0), tool_call["input"].get("asset", "")
            )
            if not allowed:
                log.warning(f"Trade blocked by guardrail: {reason}")
                messages.append({"role": "assistant", "content": response["content"]})
                messages.append({
                    "role": "user",
                    "content": _build_tool_results(tool_call["id"], {"success": False, "error": f"Guardrail: {reason}"}, tool_calls),
                })
                continue

        if tool_call["name"] == "bet":
            allowed, reason = check_trade_allowed(
                conn, tool_call["input"].get("amount_usd", 0), "PREDICTION"
            )
            if not allowed:
                log.warning(f"Bet blocked by guardrail: {reason}")
                messages.append({"role": "assistant", "content": response["content"]})
                messages.append({
                    "role": "user",
                    "content": _build_tool_results(tool_call["id"], {"success": False, "error": f"Guardrail: {reason}"}, tool_calls),
                })
                continue

        exec_result = actuator.execute(conn, tool_call["input"], context)

        if actuator.terminal:
            result["action"] = tool_call["name"]
            result["reasoning"] = tool_call["input"].get("reasoning", "")
            result["exec_result"] = exec_result
            break
        else:
            messages.append({"role": "assistant", "content": response["content"]})
            messages.append({
                "role": "user",
                "content": _build_tool_results(tool_call["id"], exec_result, tool_calls),
            })

    return result


def _is_sports_market(question: str) -> bool:
    """Check if a market question looks like a sports/esports event."""
    q = question.lower()
    if " vs " in q or " vs. " in q:
        return True
    _SPORTS_KEYWORDS = [
        "open:", "grand prix", "grand slam", "world cup",
        "nba", "nfl", "mlb", "nhl", "premier league", "la liga",
        "serie a", "bundesliga", "champions league", "europa league",
        "atp", "wta", "ufc", "bellator", "pga", "lpga",
        "counter-strike", "dota", "valorant", "league of legends",
    ]
    return any(kw in q for kw in _SPORTS_KEYWORDS)


def _is_weather_novelty_market(question: str, event_title: str = "") -> bool:
    """Check if a market is weather/temperature/novelty — unreliable momentum."""
    combined = (question + " " + event_title).lower()
    _WEATHER_KEYWORDS = [
        "temperature", "highest temp", "lowest temp", "degrees fahrenheit",
        "degrees celsius", "snowfall", "inches of snow", "rainfall",
        "precipitation", "wind speed", "weather",
    ]
    return any(kw in combined for kw in _WEATHER_KEYWORDS)


def _should_route_to_haiku(question: str, mkt_row, vel_cfg: dict) -> bool:
    """Decide whether a momentum signal needs Haiku validation or can auto-follow.

    Returns True if the signal should be routed to Haiku for validation.
    Returns False if the signal is clear enough for auto-follow (confidence=0.75, $0 API cost).

    Routes to Haiku when ANY risk trigger fires:
    1. Near-resolution: end_date < 2 hours away (exit noise risk)
    2. Mid-liquidity: $1K-$5K (manipulation gray zone)
    3. Category-ambiguous: non-sports market with " vs " in question
    """
    if not vel_cfg.get("smart_haiku_routing", False):
        return True  # routing disabled — always call Haiku (old behavior)

    # Trigger 1: near-resolution
    near_hours = vel_cfg.get("haiku_route_near_resolution_hours", 2.0)
    if mkt_row and mkt_row["end_date"]:
        from datetime import datetime, timezone
        try:
            end_dt = datetime.fromisoformat(str(mkt_row["end_date"]).replace("Z", "+00:00"))
            hours_left = (end_dt - datetime.now(timezone.utc)).total_seconds() / 3600
            if hours_left < near_hours:
                return True
        except (ValueError, TypeError):
            pass

    # Trigger 2: mid-liquidity (manipulation gray zone)
    min_liq = vel_cfg.get("haiku_route_min_liquidity", 1000.0)
    max_liq = vel_cfg.get("haiku_route_max_liquidity", 5000.0)
    if mkt_row:
        liq = mkt_row["liquidity"] if mkt_row["liquidity"] else 0
        if min_liq <= liq <= max_liq:
            return True

    # Trigger 3: category-ambiguous (non-sports with " vs " — could be political debate, etc.)
    if vel_cfg.get("haiku_route_ambiguous_category", True):
        if not _is_sports_market(question) and " vs " in question.lower():
            return True

    return False  # clear signal — auto-follow


def _analyze_momentum_opportunities(conn, cycle_id: int, pipeline_result, cfg: dict) -> list[dict]:
    """Analyze velocity alerts for pure velocity-following momentum bets.

    Direction is mechanical (from velocity sign), sizing scales with velocity
    magnitude, and Haiku validates follow/no-follow (no probability estimation).
    """
    vel_cfg = cfg.get("velocity", {})
    max_per_cycle = vel_cfg.get("max_momentum_per_cycle", 3)
    follow_confidence = vel_cfg.get("momentum_follow_confidence", 0.6)
    base_bet_pct = vel_cfg.get("momentum_base_bet_pct", 0.025)
    max_bet_pct = vel_cfg.get("momentum_max_bet_pct", 0.10)
    vel_scale_20 = vel_cfg.get("momentum_vel_scale_20", 1.5)
    vel_scale_40 = vel_cfg.get("momentum_vel_scale_40", 2.0)
    model = vel_cfg.get("momentum_model", "claude-haiku-4-5-20251001")

    velocity_alerts = sorted(
        [e for e in (pipeline_result.edges or [])
         if e.get("action") == "velocity_alert" and e.get("velocity_sharp")],
        key=lambda e: abs(e.get("z_1h") or 0) or abs(e.get("v_1h") or 0),
        reverse=True,
    )

    if not velocity_alerts:
        return []

    max_exposure_pct = vel_cfg.get("momentum_max_exposure_pct", 0.50)
    balance = ledger.get_balance(conn)

    # Build current exposure + market value per market for position-size awareness
    from vault.polymarket import get_current_odds
    open_preds = ledger.get_open_predictions(conn)
    exposure_by_market = {}
    value_by_market = {}
    for p in open_preds:
        mid = p["market_id"]
        exposure_by_market[mid] = exposure_by_market.get(mid, 0) + p["cost_basis"]
        odds = get_current_odds(conn, mid)
        if odds:
            cp = odds["yes_price"] if p["side"] == "YES" else odds["no_price"]
            value_by_market[mid] = value_by_market.get(mid, 0) + p["shares"] * cp
        else:
            value_by_market[mid] = value_by_market.get(mid, 0) + p["cost_basis"]

    # Build position lookup: (market_id, side) → existing predictions
    open_pred_by_market_side = {}
    for p in open_preds:
        key = (p["market_id"], p["side"])
        open_pred_by_market_side.setdefault(key, []).append(p)

    add_min_roi = vel_cfg.get("momentum_add_min_roi", 0.0)
    total_value = balance + sum(value_by_market.values())
    base_bet = round(total_value * base_bet_pct, 2)
    max_bet = round(total_value * max_bet_pct, 2)

    # Per-market position count (all sides combined)
    positions_per_market = {}
    for p in open_preds:
        mid = p["market_id"]
        positions_per_market[mid] = positions_per_market.get(mid, 0) + 1
    max_positions_per_market = vel_cfg.get("momentum_max_positions_per_market", 5)

    items = []
    total_api_cost = 0  # Track all Haiku calls including skipped signals
    for alert in velocity_alerts:
        question = alert.get("question", alert["market_id"])
        v_1h = alert.get("v_1h")
        v_6h = alert.get("v_6h")

        # Market-type filter: skip O/U, draw, spread (noisy in-game momentum)
        _NOISY_PATTERNS = ["over/under", "o/u ", " o/u", "total points", "total goals",
                           "total maps", "spread", "end in a draw", "draw or",
                           "by at least", "margin"]
        q_lower = question.lower()
        if any(pat in q_lower for pat in _NOISY_PATTERNS):
            log.info(f"Momentum skip (noisy market type): {question[:50]}")
            continue

        # Guard 3: Failed-market cooldown — skip markets that recently failed on CLOB
        from vault.db import get_meta as _get_meta
        _failed_ts_str = _get_meta(conn, f"failed_market:{alert['market_id']}")
        if _failed_ts_str:
            from datetime import datetime, timezone
            try:
                _failed_ts = datetime.fromisoformat(_failed_ts_str)
                _cooldown_min = vel_cfg.get("failed_market_cooldown_minutes", 10)
                _elapsed = (datetime.now(timezone.utc) - _failed_ts).total_seconds() / 60
                if _elapsed < _cooldown_min:
                    log.info(f"Momentum skip (failed-market cooldown): {question[:50]} — "
                             f"CLOB failed {_elapsed:.1f}m ago, cooldown {_cooldown_min}m")
                    continue
            except (ValueError, TypeError):
                pass

        # Fetch LIVE odds (alert's market_odds may be stale from musk_markets table)
        live_odds = get_current_odds(conn, alert["market_id"])
        if not live_odds:
            log.info(f"Momentum skip (no live odds): {question[:50]}")
            continue
        market_odds = live_odds["yes_price"]

        # 1. Mechanical direction: v_1h sign → side
        if v_1h is None or v_1h == 0:
            log.info(f"Momentum skip (no v_1h): {question[:50]}")
            continue
        side = "NO" if v_1h < 0 else "YES"
        entry_price = market_odds if side == "YES" else (1 - market_odds)
        remaining = _remaining_return_pct(entry_price)

        # 2. Extreme odds filter — check ENTRY side, not just YES side
        if entry_price >= 0.995:
            log.info(f"Momentum skip (extreme entry): {question[:50]} — {side} @ {entry_price:.2%}")
            continue

        # 2b. Minimum entry odds — very low entries are noise (sub-10% means 90%+ odds against)
        if entry_price < 0.10:
            log.info(f"Momentum skip (extreme low entry): {question[:50]} — {side} @ {entry_price:.2%}")
            continue

        # 2c. Fetch market context (used for spread/liquidity/volume filter + Haiku prompt)
        mkt_row = conn.execute(
            "SELECT end_date, description, volume, volume_24h, liquidity, spread, competitive, "
            "game_start_time, event_title FROM musk_markets WHERE market_id = ?",
            (alert["market_id"],),
        ).fetchone()

        # 2d. Skip illiquid/wide-spread/low-volume markets (unreliable prices, false velocity)
        mkt_spread = mkt_row["spread"] if mkt_row and mkt_row["spread"] else 0
        mkt_liquidity = mkt_row["liquidity"] if mkt_row and mkt_row["liquidity"] else 0
        mkt_volume = mkt_row["volume"] if mkt_row and mkt_row["volume"] else 0
        min_volume = vel_cfg.get("momentum_min_volume", 10000)
        if mkt_volume < min_volume:
            log.info(f"Momentum skip (low volume ${mkt_volume:,.0f} < ${min_volume:,.0f}): {question[:50]}")
            continue
        # Extract event_title for theme tracking in logs
        event_title = mkt_row["event_title"] if mkt_row and mkt_row["event_title"] else ""

        # Weather/novelty filter: momentum signals on temperature/weather are meaningless
        if _is_weather_novelty_market(question, event_title):
            log.info(f"Momentum skip (weather/novelty market): {question[:50]}")
            continue

        if mkt_spread > 0.10:
            log.info(f"Momentum skip (wide spread {mkt_spread:.0%}): {question[:50]}")
            continue
        if mkt_liquidity > 0 and mkt_liquidity < 50:
            log.info(f"Momentum skip (low liquidity ${mkt_liquidity:.0f}): {question[:50]}")
            continue

        # 3. Velocity-scaled sizing (pure raw velocity)
        z_1h = alert.get("z_1h")
        abs_v = abs(v_1h)

        # 3a. Minimum velocity filter — sports get lower floor (5%) vs default (10%)
        is_sports = _is_sports_market(question)
        momentum_min_velocity = vel_cfg.get(
            "momentum_min_velocity_1h_sports" if is_sports else "momentum_min_velocity_1h",
            0.05 if is_sports else 0.10,
        )
        if abs_v < momentum_min_velocity:
            # Z-score gate: allow lower velocity if move is statistically significant
            z_override_min_vel = vel_cfg.get("z_override_min_velocity", 0.07)
            z_override_threshold = vel_cfg.get("z_override_threshold", 4.0)
            z_gate_passes = (
                not is_sports
                and z_1h is not None
                and abs(z_1h) >= z_override_threshold
                and abs_v >= z_override_min_vel
            )
            if not z_gate_passes:
                mtype = "sports" if is_sports else "non-sports"
                log.info(f"Momentum skip (weak velocity, {mtype}): {question[:50]} — |v_1h| {abs_v:.1%} < {momentum_min_velocity:.0%}")
                continue
            log.info(
                f"Momentum z-gate override: {question[:50]} — "
                f"|v_1h| {abs_v:.1%} < {momentum_min_velocity:.0%} but z={z_1h:.1f} >= {z_override_threshold}"
            )
        # Oscillation dampener: detect noisy mean-reverting markets
        osc_max_rev = vel_cfg.get("oscillation_max_reversals", 6)
        osc_net_override = vel_cfg.get("oscillation_net_move_override", 0.15)
        reversals_2h = alert.get("reversals_2h", 0)
        net_move_2h = alert.get("net_move_2h", 0.0)
        is_oscillating = (reversals_2h >= osc_max_rev
                          and abs(net_move_2h) < osc_net_override)

        if is_oscillating:
            log.info(
                f"Oscillation dampener: {question[:50]} — "
                f"{reversals_2h} reversals, net {net_move_2h:+.0%} "
                f"(capped to 1 position, no pyramid)"
            )

        # Burned-market guard: restrict markets where we've already lost money
        from datetime import datetime, timezone, timedelta
        burned_lookback = vel_cfg.get("burned_market_lookback_hours", 4.0)
        burned_threshold = vel_cfg.get("burned_market_loss_threshold", -2.00)
        burned_cutoff = (datetime.now(timezone.utc) - timedelta(hours=burned_lookback)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        burned_row = conn.execute(
            "SELECT COALESCE(SUM(pnl), 0) as net_pnl FROM predictions "
            "WHERE market_id = ? AND closed_at IS NOT NULL AND closed_at > ?",
            (alert["market_id"], burned_cutoff),
        ).fetchone()
        burned_pnl = burned_row["net_pnl"] if burned_row else 0
        is_burned = burned_pnl <= burned_threshold

        if is_burned:
            log.info(
                f"Burned-market guard: {question[:50]} — "
                f"net realised ${burned_pnl:+.2f} in {burned_lookback:.0f}h "
                f"(capped to 1 position, no pyramid)"
            )

        if abs_v >= 0.40:
            vel_mult = vel_scale_40
        elif abs_v >= 0.20:
            vel_mult = vel_scale_20
        else:
            vel_mult = 1.0
        raw_bet = min(base_bet * vel_mult, max_bet, total_value * 0.15)

        # Pyramiding: scale bet size based on unrealised ROI of existing exposure
        current_exposure = exposure_by_market.get(alert["market_id"], 0)
        current_value = value_by_market.get(alert["market_id"], 0)
        unrealised_roi = (current_value - current_exposure) / current_exposure if current_exposure > 0 else 0
        pyramid_enabled = vel_cfg.get("momentum_pyramid_enabled", True)
        if not pyramid_enabled:
            pyramid_mult = 1.0
        elif is_oscillating or is_burned:
            pyramid_mult = 1.0
        elif unrealised_roi >= 0.30:
            pyramid_mult = 3.0
        elif unrealised_roi >= 0.15:
            pyramid_mult = 2.0
        elif unrealised_roi >= 0.05:
            pyramid_mult = 1.5
        else:
            pyramid_mult = 1.0

        # Cap bet size (respect remaining room under exposure cap)
        max_exposure_usd = total_value * max_exposure_pct
        remaining_room = max_exposure_usd - current_exposure
        bet_size = min(raw_bet * pyramid_mult, remaining_room, max_bet)
        bet_size = round(max(bet_size, 0), 2)

        if bet_size <= 0:
            log.info(
                f"Momentum skip: {question[:50]} — exposure ${current_exposure:.2f} "
                f">= {max_exposure_pct:.0%} cap (${max_exposure_usd:.2f})"
            )
            _log_smart_money_event(
                conn, cycle_id=cycle_id, market_id=alert["market_id"],
                question=question,
                vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
                action_taken="momentum_skip",
                market_odds=market_odds, side=side,
            )
            continue

        # CLOB hard minimum: Polymarket rejects marketable BUY orders below $1.
        # In real mode, skip here — don't waste a CLOB call that definitely fails,
        # which would also trigger the failed-market cooldown and lock the market
        # out for 10 minutes on a local sizing issue.
        is_simulated = cfg.get("trading", {}).get("simulated", True)
        if not is_simulated:
            min_order_usd = cfg.get("trading", {}).get("clob", {}).get("min_order_usd", 1.00)
            if bet_size < min_order_usd:
                log.info(
                    f"Momentum skip (below CLOB min): {question[:50]} — "
                    f"sized ${bet_size:.2f} < ${min_order_usd:.2f} CLOB minimum "
                    f"(raise momentum_base_bet_pct or top up balance)"
                )
                continue

        # Per-market position count cap (oscillation dampener overrides to 1)
        effective_max_positions = 1 if (is_oscillating or is_burned) else max_positions_per_market
        market_pos_count = positions_per_market.get(alert["market_id"], 0)
        if market_pos_count >= effective_max_positions:
            # Shadow evaluate before skipping — this is the primary trigger
            # for shadow trades (position cap blocks the old path at line 745)
            if current_exposure > 0 and not pyramid_enabled:
                _evaluate_shadow_variants(
                    conn, cfg, cycle_id=cycle_id,
                    market_id=alert["market_id"], question=question,
                    side=side, entry_price=entry_price,
                    raw_bet=raw_bet, unrealised_roi=unrealised_roi,
                    v_1h=v_1h, v_6h=v_6h, z_1h=z_1h,
                )
            shadow_tag = " (shadow evaluated)" if current_exposure > 0 and not pyramid_enabled else ""
            log.info(
                f"Momentum skip: {question[:50]} — {market_pos_count} positions "
                f">= {effective_max_positions} cap{shadow_tag}"
            )
            continue

        # Unrealised loss floor: block entry when open positions on this market are underwater
        unrealised_loss_floor = vel_cfg.get("momentum_unrealised_loss_floor", -0.05)
        if current_exposure > 0 and unrealised_roi < unrealised_loss_floor:
            log.info(
                f"Momentum skip (unrealised loss floor): {question[:50]} — "
                f"ROI {unrealised_roi:+.1%} < {unrealised_loss_floor:.0%} floor, "
                f"exposure ${current_exposure:.2f}"
            )
            _log_smart_money_event(
                conn, cycle_id=cycle_id, market_id=alert["market_id"],
                question=question,
                vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h,
                     "direction": "neutral", "sharp": True},
                action_taken="momentum_skip",
                market_odds=market_odds, side=side,
            )
            continue

        if pyramid_mult > 1:
            log.info(
                f"Momentum pyramid: {question[:40]} — ROI {unrealised_roi:+.0%} → "
                f"{pyramid_mult:.0f}x size (${bet_size:.2f})"
            )

        # 3b. Opposite-side guard — never bet against an existing position
        opposite_side = "NO" if side == "YES" else "YES"
        if (alert["market_id"], opposite_side) in open_pred_by_market_side:
            log.info(
                f"Momentum skip (opposite side): {question[:50]} — "
                f"want {side} but have {opposite_side} position"
            )
            continue

        # 4. Position-aware validation: add vs new entry
        is_add = (alert["market_id"], side) in open_pred_by_market_side

        # Side-switch velocity floor: if we've previously closed the opposite side,
        # require higher velocity to re-enter on this side (filters weak flips).
        if not is_add:
            from datetime import datetime, timezone, timedelta
            switch_window = vel_cfg.get("momentum_flip_window_hours", 4.0)
            switch_min_vel = vel_cfg.get("side_switch_min_velocity_1h", 0.15)
            now_utc = datetime.now(timezone.utc)
            switch_start = (now_utc - timedelta(hours=switch_window)).strftime(
                "%Y-%m-%dT%H:%M:%S"
            )
            opposite_side = "NO" if side == "YES" else "YES"
            had_opposite = conn.execute(
                "SELECT 1 FROM predictions "
                "WHERE market_id = ? AND side = ? AND closed_at IS NOT NULL AND closed_at > ? "
                "LIMIT 1",
                (alert["market_id"], opposite_side, switch_start),
            ).fetchone()
            if had_opposite and abs(v_1h) < switch_min_vel:
                log.info(
                    f"Momentum skip (side-switch velocity floor): {question[:50]} — "
                    f"want {side} but closed {opposite_side} recently, "
                    f"|v_1h|={abs(v_1h):.0%} < {switch_min_vel:.0%} required"
                )
                continue

        # Multi-flip guard: allow one side-change per market, block the second.
        # First flip (e.g. NO→YES) is a legitimate reversal — allow it.
        # Second flip (YES→NO→YES) means we're oscillating — block until cooldown.
        # Only applies to NEW entries, not pyramid adds to open positions.
        if not is_add:
            from datetime import datetime, timezone, timedelta
            flip_window = vel_cfg.get("momentum_flip_window_hours", 4.0)
            flip_cooldown = vel_cfg.get("momentum_flip_cooldown_hours", 1.0)
            now_utc = datetime.now(timezone.utc)
            window_start = (now_utc - timedelta(hours=flip_window)).strftime(
                "%Y-%m-%dT%H:%M:%S"
            )

            recent_closed = conn.execute(
                "SELECT DISTINCT side FROM predictions "
                "WHERE market_id = ? AND closed_at IS NOT NULL AND closed_at > ?",
                (alert["market_id"], window_start),
            ).fetchall()
            distinct_closed_sides = set(r["side"] for r in recent_closed)

            if len(distinct_closed_sides) >= 2:
                most_recent = conn.execute(
                    "SELECT closed_at FROM predictions "
                    "WHERE market_id = ? AND closed_at IS NOT NULL "
                    "ORDER BY closed_at DESC LIMIT 1",
                    (alert["market_id"],),
                ).fetchone()
                if most_recent and most_recent["closed_at"]:
                    closed_ts = datetime.fromisoformat(
                        most_recent["closed_at"].replace("Z", "+00:00")
                    )
                    hours_since = (now_utc - closed_ts).total_seconds() / 3600
                    if hours_since < flip_cooldown:
                        log.info(
                            f"Momentum skip (multi-flip guard): {question[:50]} — "
                            f"traded both sides within {flip_window:.0f}h, "
                            f"last close {hours_since:.1f}h ago"
                        )
                        _log_smart_money_event(
                            conn, cycle_id=cycle_id, market_id=alert["market_id"],
                            question=question,
                            vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h,
                                 "direction": "neutral", "sharp": True},
                            action_taken="momentum_skip",
                            market_odds=market_odds, side=side,
                        )
                        continue

        if is_add:
            if not pyramid_enabled:
                # Pyramid adds disabled — evaluate shadow variants, then skip
                _evaluate_shadow_variants(
                    conn, cfg, cycle_id=cycle_id,
                    market_id=alert["market_id"], question=question,
                    side=side, entry_price=entry_price,
                    raw_bet=raw_bet, unrealised_roi=unrealised_roi,
                    v_1h=v_1h, v_6h=v_6h, z_1h=z_1h,
                )
                log.info(
                    f"Momentum skip (pyramid disabled): {question[:50]} — "
                    f"{side} ROI {unrealised_roi:+.1%} (shadow evaluated)"
                )
                _log_smart_money_event(
                    conn, cycle_id=cycle_id, market_id=alert["market_id"],
                    question=question,
                    vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
                    action_taken="momentum_skip",
                    market_odds=market_odds, side=side,
                )
                continue

            # Add cooldown — prevent rapid-fire stacking on the same market+side
            add_cooldown_min = vel_cfg.get("momentum_add_cooldown_minutes", 10)
            last_add = conn.execute(
                "SELECT opened_at FROM predictions "
                "WHERE market_id = ? AND side = ? AND status = 'open' "
                "ORDER BY opened_at DESC LIMIT 1",
                (alert["market_id"], side),
            ).fetchone()
            if last_add and last_add["opened_at"]:
                from datetime import datetime, timezone, timedelta
                last_ts = datetime.fromisoformat(last_add["opened_at"].replace("Z", "+00:00"))
                now_utc = datetime.now(timezone.utc)
                minutes_since = (now_utc - last_ts).total_seconds() / 60
                if minutes_since < add_cooldown_min:
                    log.info(
                        f"Momentum skip (add cooldown): {question[:50]} — "
                        f"last add {minutes_since:.1f}m ago < {add_cooldown_min}m"
                    )
                    continue

            # Existing same-side position — gate on profitability, skip Haiku
            if unrealised_roi <= add_min_roi:
                log.info(
                    f"Momentum skip (add, not profitable): {question[:50]} — "
                    f"ROI {unrealised_roi:+.1%} <= {add_min_roi:.0%}"
                )
                _log_smart_money_event(
                    conn, cycle_id=cycle_id, market_id=alert["market_id"],
                    question=question,
                    vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
                    action_taken="momentum_skip",
                    market_odds=market_odds, side=side,
                )
                continue

            # Profitable position — synthetic validation, $0 API cost
            follow = True
            conf = 0.8
            reasoning = (
                f"Add to profitable {side} position (ROI {unrealised_roi:+.1%}, "
                f"v_1h={v_1h:+.0%})"
            )
            log.info(
                f"Momentum add candidate: {question[:50]} — {side} ${bet_size:.2f} "
                f"(ROI {unrealised_roi:+.1%}, no Haiku call)"
            )
        else:
            # New entry — smart routing: only call Haiku when risk triggers fire
            item_api_cost = 0
            if _should_route_to_haiku(question, mkt_row, vel_cfg):
                market_context = dict(mkt_row) if mkt_row else {}
                analysis = _call_momentum_haiku(
                    conn, cycle_id, question, v_1h, v_6h, market_odds,
                    side, entry_price, remaining, model, cfg,
                    z_1h=z_1h, market_context=market_context,
                )
                if not analysis:
                    _log_smart_money_event(
                        conn, cycle_id=cycle_id, market_id=alert["market_id"],
                        question=question,
                        vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
                        action_taken="momentum_skip",
                        market_odds=market_odds, side=side,
                    )
                    continue

                item_api_cost = analysis.get("api_cost", 0)
                total_api_cost += item_api_cost
                follow = analysis["follow"]
                conf = analysis["confidence"]
                reasoning = analysis["reasoning"]
            else:
                # Auto-follow: clear signal, $0 API cost
                follow = True
                conf = 0.75
                reasoning = (
                    f"Momentum auto-follow: {side} v_1h={v_1h:+.0%} "
                    f"(clear signal, no risk triggers)"
                )
                log.info(f"Momentum auto-follow: {question[:50]} — {side} ${bet_size:.2f}")

        # 4b. Z-score confidence adjustment (high z = boost, low z = haircut)
        #     Profitable adds are exempt from haircut — don't neuter winners
        z_conf_boost = vel_cfg.get("z_confidence_boost", 0.15)
        z_conf_haircut = vel_cfg.get("z_confidence_haircut", 0.10)
        z_high_threshold = vel_cfg.get("z_sizing_high", 4.0)
        z_low_threshold = vel_cfg.get("z_sizing_low", 3.0)
        if z_1h is not None and follow:
            abs_z = abs(z_1h)
            if abs_z >= z_high_threshold:
                conf = min(1.0, conf + z_conf_boost)
            elif abs_z < z_low_threshold and not is_add:
                conf = max(0.1, conf - z_conf_haircut)

        # 5. Confidence gate (applies to both adds and new entries)
        if not follow or conf < follow_confidence:
            skip_reason = f"follow={follow}" if not follow else f"conf {conf:.0%} < {follow_confidence:.0%}"
            log.info(
                f"Momentum skip: {question[:50]} — {skip_reason} — {reasoning[:80]}"
            )
            _log_smart_money_event(
                conn, cycle_id=cycle_id, market_id=alert["market_id"],
                question=question,
                vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
                action_taken="momentum_skip",
                market_odds=market_odds, side=side,
            )
            continue

        # 6. Opportunity cost gate — don't enter if remaining return < risk-free
        annual_rate = vel_cfg.get("opportunity_cost_annual", 0.10)
        default_days = vel_cfg.get("opportunity_cost_default_days", 30)
        days = _days_to_resolution(mkt_row["end_date"] if mkt_row else None, default_days)
        risk_free = annual_rate * (days / 365)
        if entry_price >= 0.995 or remaining <= risk_free:
            log.info(
                f"Momentum skip (opportunity cost): {question[:40]} — "
                f"remaining {remaining:.2%} < risk-free {risk_free:.2%} ({days:.0f}d)"
            )
            _log_smart_money_event(
                conn, cycle_id=cycle_id, market_id=alert["market_id"],
                question=question,
                vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
                action_taken="momentum_skip",
                market_odds=market_odds, side=side,
            )
            continue

        action_tag = "momentum_add" if is_add else "momentum_bet"
        item = {
            "market_id": alert["market_id"],
            "question": question,
            "market_odds": market_odds,
            "side": side,
            "entry_price": entry_price,
            "v_1h": v_1h,
            "v_6h": v_6h,
            "z_1h": z_1h,
            "abs_v_1h": abs_v,
            "follow_confidence": round(conf, 4),
            "reasoning": f"{'[OSCILLATION DAMPENED] ' if is_oscillating else '[BURNED MARKET] ' if is_burned else ''}Momentum {'add' if is_add else 'follow'}: {reasoning}",
            "recommended_size_usd": bet_size,
            "velocity_sharp": True,
            "source": "momentum",
            "api_cost": 0 if is_add else item_api_cost,
        }
        items.append(item)

        _log_smart_money_event(
            conn, cycle_id=cycle_id, market_id=alert["market_id"],
            question=question,
            vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
            action_taken=action_tag,
            market_odds=market_odds, side=side, amount_usd=bet_size,
            confidence=conf,
        )

        z_part = f", z={z_1h:.1f}" if z_1h is not None else ""
        theme_part = f", theme='{event_title[:40]}'" if event_title else ""
        log.info(
            f"Momentum {action_tag} candidate: {question[:50]} — {side} ${bet_size:.2f} "
            f"(v={v_1h:+.0%}/1h{z_part}, conf={conf:.0%}{theme_part})"
        )

        # Cap accepted candidates per cycle (applied after filters, not before)
        if len(items) >= max_per_cycle:
            break

    return items, total_api_cost


def _call_momentum_haiku(conn, cycle_id, question, v_1h, v_6h, market_odds,
                         side, entry_price, remaining, model, cfg,
                         z_1h=None, market_context=None):
    """Call Haiku for momentum follow/no-follow validation. Returns parsed dict or None."""
    system, user = build_momentum_prompt(
        question, v_1h, v_6h, market_odds, side, entry_price, remaining,
        z_1h=z_1h, market_context=market_context,
    )

    try:
        response = call_claude(
            conn=conn,
            ledger_mod=ledger,
            model=model,
            system=system,
            messages=[{"role": "user", "content": user}],
            cycle_id=cycle_id,
            purpose="momentum_validation",
            max_tokens=256,
        )
        text = " ".join(b["text"] for b in response["content"] if b["type"] == "text")
        cost = response.get("cost", 0)
        log.info(f"Haiku momentum raw: {question[:40]} — {text[:200]}")
        result = _parse_momentum_response(text)
        if result:
            result["api_cost"] = cost
        return result
    except Exception as e:
        log.warning(f"Momentum Haiku call failed: {e}")
        return None


def _parse_momentum_response(text: str) -> dict | None:
    """Parse JSON response from momentum Haiku (follow/confidence/reasoning)."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    def _extract(parsed):
        if not isinstance(parsed, dict):
            return None
        follow = parsed.get("follow")
        conf = parsed.get("confidence")
        if follow is None or conf is None:
            return None
        return {
            "follow": bool(follow),
            "confidence": float(conf),
            "reasoning": parsed.get("reasoning", ""),
        }

    try:
        result = _extract(json.loads(text))
        if result:
            return result
    except (json.JSONDecodeError, ValueError, TypeError):
        pass

    # Try to find JSON in text
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            result = _extract(json.loads(text[start:end + 1]))
            if result:
                return result
        except (json.JSONDecodeError, ValueError, TypeError):
            pass

    return None


def _execute_momentum_bets(conn, cycle_id: int, momentum_items: list[dict],
                           context: dict) -> dict:
    """Execute best momentum bet directly — bypasses decider.

    Picks the best candidate by |v_1h| * haiku_confidence, then calls the
    bet actuator. Returns a cycle result dict.
    """
    result = {"cycle_id": cycle_id, "action": None, "rounds": 0, "total_cost": 0}

    if not momentum_items:
        result["action"] = "hold"
        result["reasoning"] = "no momentum candidates passed validation"
        return result

    # Pick best by signal strength * haiku_confidence (z-score preferred, raw fallback)
    momentum_items.sort(
        key=lambda x: (abs(x.get("z_1h") or 0) or x.get("abs_v_1h", 0)) * x.get("follow_confidence", 0),
        reverse=True,
    )
    best = momentum_items[0]

    market_id = best["market_id"]
    side = best["side"]
    amount_usd = best["recommended_size_usd"]
    reasoning = best["reasoning"]

    # Guardrail check
    allowed, block_reason = check_trade_allowed(conn, amount_usd, "PREDICTION")
    if not allowed:
        log.warning(f"Momentum bet blocked by guardrail: {block_reason}")
        result["action"] = "hold"
        result["reasoning"] = f"momentum bet blocked: {block_reason}"
        return result

    # Death check
    if check_death(conn):
        result["action"] = "death"
        return result

    # Inject momentum data into pipeline_edges so bet actuator picks it up
    if "pipeline_edges" not in context:
        context["pipeline_edges"] = []
    context["pipeline_edges"].append({
        "market_id": market_id,
        "edge": best.get("abs_v_1h", 0),       # Store velocity magnitude as entry_edge
        "confidence": best.get("follow_confidence", 0),
        "reasoning": reasoning,
    })

    bet_actuator = get_actuator("bet")
    exec_result = bet_actuator.execute(conn, {
        "market_id": market_id,
        "side": side,
        "amount_usd": amount_usd,
        "reasoning": reasoning,
    }, context)

    if exec_result.get("success"):
        result["action"] = "bet"
        result["reasoning"] = reasoning
        result["exec_result"] = exec_result
        log.info(
            f"Momentum direct exec: BET {side} ${amount_usd:.2f} on "
            f"{best['question'][:50]} (v={best.get('v_1h', 0):+.0%}/1h)"
        )
    else:
        # Guard 3: Record failed-market cooldown to prevent re-entry loop.
        # Skip for dry-run rejections — those aren't real failures, they're a
        # deliberate startup safety gate. Marking the market failed for 10 min
        # would lose a real opportunity once dry-run completes.
        err_msg = exec_result.get('error', '') or ''
        is_dry_run_skip = 'Dry-run mode' in err_msg
        if not is_dry_run_skip:
            from vault.db import set_meta as _set_meta
            from datetime import datetime, timezone
            _set_meta(conn, f"failed_market:{market_id}", datetime.now(timezone.utc).isoformat())
        conn.commit()
        result["action"] = "hold"
        result["reasoning"] = f"momentum bet failed: {exec_result.get('error', 'unknown')}"
        log.warning(f"Momentum bet failed: {exec_result.get('error')}")

    return result


def _remaining_return_pct(our_price: float) -> float:
    """Max possible return if position resolves in our favour."""
    if our_price <= 0:
        return float('inf')
    if our_price >= 1.0:
        return 0.0
    return (1.0 - our_price) / our_price


def _days_to_resolution(end_date: str | None, default_days: float = 30.0) -> float:
    """Days until market resolves. Falls back to default if no end_date."""
    if not end_date:
        return default_days
    from datetime import datetime, timezone
    try:
        end_dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        days = (end_dt - datetime.now(timezone.utc)).total_seconds() / 86400
        return max(days, 0.04)  # ~1 hour floor — market could resolve any moment
    except (ValueError, TypeError):
        return default_days


def _sell_prediction_auto(conn, pred: dict, our_price: float) -> float:
    """Sell a prediction, routing through CLOB for real positions.

    Used by all automated exit functions (trailing stop, stale, reversal, etc.).
    Returns the realised P&L.
    """
    cfg = load_config()
    is_simulated = cfg.get("trading", {}).get("simulated", True)
    execution_mode = pred.get("execution_mode", "paper")

    if not is_simulated and execution_mode == "real":
        token_id = pred.get("clob_token_id")
        if not token_id:
            log.warning(f"Real position {pred['id']} missing clob_token_id, selling at paper price")
        else:
            from vault.clob_client import sell_shares
            clob_cfg = cfg.get("trading", {}).get("clob", {})
            slippage = clob_cfg.get("slippage_pct", 0.02)
            min_price = max(our_price - slippage, 0.01)
            fill = sell_shares(token_id, pred["shares"], min_price=min_price)
            if fill.success:
                our_price = fill.avg_price
                log.info(f"CLOB auto-sell filled for [{pred['id']}]: {fill.shares:.4f} @ {fill.avg_price:.4f}")
            else:
                raise RuntimeError(f"CLOB sell failed for [{pred['id']}]: {fill.error}")

    return ledger.record_prediction_sell(conn, pred["id"], our_price)


def _exit_substandard_positions(conn, open_preds, odds_cache):
    """Exit positions that no longer meet current entry minimums.

    Applies current confidence and edge thresholds retroactively to open positions.
    Pipeline positions entered under looser rules get closed if they don't meet
    today's standards. Only applies to pipeline positions (entry_confidence > 0).
    """
    cfg = load_config()
    edge_cfg = cfg.get("edge", {})
    min_confidence = edge_cfg.get("min_confidence", 0.4)
    margin_of_safety = edge_cfg.get("margin_of_safety", 0.10)

    for pred in open_preds:
        reasoning = pred.get("entry_reasoning") or ""
        if reasoning.startswith("Momentum") or reasoning.startswith("Sharp move"):
            continue  # momentum positions use velocity, not edge/confidence
        conf = pred.get("entry_confidence")
        if not conf or conf <= 0:
            continue  # legacy — not subject to intel gates

        edge = abs(pred.get("entry_edge") or 0)
        reason = None
        if conf < min_confidence:
            reason = f"confidence {conf:.2f} < {min_confidence:.2f}"
        elif edge < margin_of_safety:
            reason = f"edge {edge:.0%} < {margin_of_safety:.0%}"

        if reason:
            odds = odds_cache.get(pred["market_id"])
            if not odds:
                continue
            our_price = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
            try:
                pnl = _sell_prediction_auto(conn, pred, our_price)
                log.info(
                    f"Substandard exit: [{pred['id']}] {pred['side']} "
                    f"'{pred['question'][:40]}' — {reason} — P&L: ${pnl:+.2f}"
                )
            except Exception as e:
                log.warning(f"Failed substandard exit {pred['id']}: {e}")


def _exit_momentum_reversal(conn, open_preds, odds_cache):
    """Exit momentum positions where velocity has flipped against our side.

    The thesis for a momentum bet is: velocity is moving sharply in our direction.
    If velocity reverses (moves against us at meaningful speed), the thesis is
    broken — exit immediately. No hold timer, no minimum loss threshold.
    """
    from vault.edge_calculator import calculate_velocity

    cfg = load_config()
    vel_cfg = cfg.get("velocity", {})
    reversal_threshold = vel_cfg.get("momentum_reversal_threshold", 0.05)

    for pred in open_preds:
        reasoning = pred.get("entry_reasoning") or ""
        if not (reasoning.startswith("Momentum") or reasoning.startswith("Sharp move")):
            continue

        vel = calculate_velocity(conn, pred["market_id"], cfg=cfg)
        if not vel or vel.get("v_1h") is None:
            continue

        v = vel["v_1h"]
        reversed_against = False
        if pred["side"] == "YES" and v < -reversal_threshold:
            reversed_against = True
        elif pred["side"] == "NO" and v > reversal_threshold:
            reversed_against = True

        if not reversed_against:
            continue

        odds = odds_cache.get(pred["market_id"])
        if not odds:
            continue
        our_price = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]

        try:
            pnl = _sell_prediction_auto(conn, pred, our_price)
            log.info(
                f"Momentum reversal exit: [{pred['id']}] {pred['side']} "
                f"'{pred['question'][:40]}' @ {our_price:.2%} — "
                f"v_1h={v:+.1%} reversed against {pred['side']} — PnL: ${pnl:+.2f}"
            )
        except Exception as e:
            log.warning(f"Failed momentum reversal exit {pred['id']}: {e}")


def _exit_stale_momentum(conn, open_preds, odds_cache):
    """Exit momentum positions where momentum has stalled and we're in profit,
    or where momentum has died and we've held too long."""
    from datetime import datetime, timezone
    from vault.edge_calculator import calculate_velocity

    cfg = load_config()
    vel_cfg = cfg.get("velocity", {})
    stale_min_hours_profitable = vel_cfg.get("stale_min_hours_profitable", 2.0)
    stale_min_hours_losing = vel_cfg.get("stale_min_hours_losing", 1.0)
    stale_max_hours = vel_cfg.get("stale_max_hours", 4.0)
    stale_vel_threshold = vel_cfg.get("stale_velocity_threshold", 0.02)

    for pred in open_preds:
        # Only momentum positions
        reasoning = pred.get("entry_reasoning") or ""
        if not (reasoning.startswith("Momentum") or reasoning.startswith("Sharp move")):
            continue

        # Hold duration
        if not pred.get("opened_at"):
            continue
        opened = datetime.fromisoformat(pred["opened_at"].replace("Z", "+00:00"))
        hours_held = (datetime.now(timezone.utc) - opened).total_seconds() / 3600

        # Current odds + P&L
        odds = odds_cache.get(pred["market_id"])
        if not odds:
            continue
        our_price = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
        current_value = pred["shares"] * our_price
        unrealised_pnl = current_value - pred["cost_basis"]
        profitable = unrealised_pnl > 0

        # Split floor: let winners breathe (2h), cut losers fast (1h)
        min_hours = stale_min_hours_profitable if profitable else stale_min_hours_losing
        if hours_held < min_hours:
            continue

        # Current velocity
        vel = calculate_velocity(conn, pred["market_id"], cfg=cfg)

        # Is momentum still alive in our direction?
        momentum_alive = False
        if vel and vel.get("v_1h") is not None:
            v = vel["v_1h"]
            if pred["side"] == "YES" and v > stale_vel_threshold:
                momentum_alive = True
            elif pred["side"] == "NO" and v < -stale_vel_threshold:
                momentum_alive = True

        if momentum_alive and hours_held < stale_max_hours:
            continue  # momentum still running and under hard cap, hold

        # Momentum stalled or hard time cap reached — should we exit?
        should_exit = False
        reason = ""

        if hours_held >= stale_max_hours:
            should_exit = True
            reason = (f"Hard time cap: held {hours_held:.1f}h >= {stale_max_hours}h, "
                      f"PnL ${unrealised_pnl:+.2f} — no position held past {stale_max_hours}h")
        elif profitable:
            should_exit = True
            reason = (f"Stale momentum profit-take: held {hours_held:.1f}h, "
                      f"PnL ${unrealised_pnl:+.2f}, momentum stalled")

        if should_exit:
            try:
                pnl = _sell_prediction_auto(conn, pred, our_price)
                log.info(
                    f"Stale momentum exit: [{pred['id']}] {pred['side']} "
                    f"'{pred['question'][:40]}' @ {our_price:.2%} — {reason} — PnL: ${pnl:+.2f}"
                )
            except Exception as e:
                log.warning(f"Failed stale momentum exit {pred['id']}: {e}")


def _exit_trailing_stop(conn, open_preds, odds_cache):
    """Exit momentum positions where ROI has dropped significantly from peak."""
    cfg = load_config()
    vel_cfg = cfg.get("velocity", {})
    trail_drop = vel_cfg.get("trailing_stop_drop", 0.15)
    trail_min_peak = vel_cfg.get("trailing_stop_min_peak", 0.15)
    trail_min_pnl_pct = vel_cfg.get("trailing_stop_min_pnl_pct", 0.05)

    for pred in open_preds:
        reasoning = pred.get("entry_reasoning") or ""
        if not (reasoning.startswith("Momentum") or reasoning.startswith("Sharp move")):
            continue

        odds = odds_cache.get(pred["market_id"])
        if not odds:
            continue
        our_price = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
        current_value = pred["shares"] * our_price
        unrealised_pnl = current_value - pred["cost_basis"]
        current_roi = unrealised_pnl / pred["cost_basis"] if pred["cost_basis"] > 0 else 0

        # Update peak_roi high-water mark
        peak_roi = pred.get("peak_roi") or 0
        if current_roi > peak_roi:
            peak_roi = current_roi
            conn.execute(
                "UPDATE predictions SET peak_roi = ? WHERE id = ?",
                (round(peak_roi, 4), pred["id"])
            )
            conn.commit()

        # Check trailing stop conditions
        if (peak_roi >= trail_min_peak
                and (peak_roi - current_roi) >= trail_drop
                and current_roi > 0
                and unrealised_pnl > (pred["cost_basis"] * trail_min_pnl_pct)):
            try:
                pnl = _sell_prediction_auto(conn, pred, our_price)
                log.info(
                    f"Trailing stop exit: [{pred['id']}] {pred['side']} "
                    f"'{pred['question'][:40]}' — peak ROI {peak_roi:+.0%}, "
                    f"current {current_roi:+.0%}, PnL: ${pnl:+.2f}"
                )
            except Exception as e:
                log.warning(f"Failed trailing stop exit {pred['id']}: {e}")


def _exit_opportunity_cost(conn, open_preds, odds_cache):
    """Exit positions where remaining return < risk-free return over the same period.

    At 10% annual opportunity cost:
      - 99.5% position resolving in 30d: 0.5% remaining vs 0.82% risk-free → EXIT
      - 95% position resolving in 7d: 5.3% remaining vs 0.19% risk-free → HOLD
      - 99% position resolving in 1d: 1.0% remaining vs 0.03% risk-free → HOLD
    """
    cfg = load_config()
    annual_rate = cfg.get("velocity", {}).get("opportunity_cost_annual", 0.10)
    default_days = cfg.get("velocity", {}).get("opportunity_cost_default_days", 30)

    for pred in open_preds:
        odds = odds_cache.get(pred["market_id"])
        if not odds:
            continue
        our_price = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
        remaining = _remaining_return_pct(our_price)
        days = _days_to_resolution(pred.get("end_date"), default_days)
        risk_free = annual_rate * (days / 365)

        if our_price >= 0.995 or remaining <= risk_free:
            try:
                pnl = _sell_prediction_auto(conn, pred, our_price)
                log.info(
                    f"Opportunity cost exit: [{pred['id']}] {pred['side']} "
                    f"'{pred['question'][:40]}' @ {our_price:.2%} — "
                    f"remaining {remaining:.2%} < risk-free {risk_free:.2%} "
                    f"({days:.0f}d) — P&L: ${pnl:+.2f}"
                )
            except Exception as e:
                log.warning(f"Failed opportunity cost exit {pred['id']}: {e}")


def run_cycle(conn) -> dict:
    """Run one agent decision cycle. Returns summary dict.

    Auto-pilot mode: only calls the decider when the pipeline finds something
    actionable (bet opportunity or exit signal). Otherwise auto-holds for $0.
    Falls back to the legacy tool-use loop if the pipeline is disabled or fails.
    """
    cfg = load_config()

    # Resolve any settled predictions before the cycle starts
    resolve_predictions(conn)

    # Portfolio drawdown circuit-breaker — before any trading logic
    cb_triggered, cb_detail = check_drawdown(conn)
    if cb_triggered:
        cur = conn.execute("INSERT INTO cycles (action) VALUES (?)", ("circuit_breaker",))
        cycle_id = cur.lastrowid
        conn.execute(
            "UPDATE cycles SET ts_end = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
            "action = 'circuit_breaker', reasoning = ?, balance_after = ? WHERE id = ?",
            (cb_detail[:500], ledger.get_balance(conn), cycle_id),
        )
        conn.commit()
        return {"cycle_id": cycle_id, "action": "circuit_breaker",
                "reasoning": cb_detail, "rounds": 0, "total_cost": 0}

    # Periodic snapshot pruning to control table growth
    prune_interval = cfg.get("snapshot_prune_interval_cycles", 50)
    cycle_count = conn.execute("SELECT COUNT(*) as c FROM cycles").fetchone()["c"]
    if cycle_count % prune_interval == 0:
        from vault.market_discovery import prune_old_snapshots
        keep_hours = cfg.get("snapshot_prune_keep_hours", 48)
        prune_old_snapshots(conn, keep_hours=keep_hours)

    # Weekly safeguard backtest to track convergence toward significance
    backtest_interval = cfg.get("backtest_interval_cycles", 10080)
    if cycle_count > 0 and cycle_count % backtest_interval == 0:
        try:
            from vault.backtester import run_backtest
            run_backtest(conn)
            log.info("Weekly safeguard backtest completed")
        except Exception as e:
            log.warning(f"Backtest failed: {e}")

    # Build shared odds cache for exit functions (avoids redundant API/DB calls)
    from vault.polymarket import get_current_odds
    open_preds = ledger.get_open_predictions(conn)
    odds_cache = {}
    for pred in open_preds:
        mid = pred["market_id"]
        if mid not in odds_cache:
            odds = get_current_odds(conn, mid)
            if odds:
                odds_cache[mid] = odds

    # Exit pipeline positions that don't meet current entry minimums
    _exit_substandard_positions(conn, open_preds, odds_cache)

    # Exit positions where remaining return < risk-free return over same period
    _exit_opportunity_cost(conn, open_preds, odds_cache)

    # Exit momentum positions where velocity has flipped against us (fastest check)
    _exit_momentum_reversal(conn, open_preds, odds_cache)

    # Exit momentum positions where ROI has dropped from peak
    _exit_trailing_stop(conn, open_preds, odds_cache)

    # Exit momentum positions where momentum has stalled
    _exit_stale_momentum(conn, open_preds, odds_cache)

    # Start cycle
    cur = conn.execute(
        "INSERT INTO cycles (action) VALUES (?)", ("pending",)
    )
    cycle_id = cur.lastrowid
    conn.commit()

    balance = ledger.get_balance(conn)

    context = {
        "cycle_id": cycle_id,
        "prices": {},
        "balance": balance,
    }

    # Run edge-detection pipeline if enabled
    pipeline_cfg = cfg.get("pipeline", {})
    pipeline_result = None
    if pipeline_cfg.get("enabled", True):
        try:
            pipeline_result = run_pipeline(conn, cycle_id)
        except Exception as e:
            log.error(f"Pipeline failed, falling back to tool loop: {e}")

    # Pass pipeline edges to context for actuators
    if pipeline_result and pipeline_result.edges:
        context["pipeline_edges"] = pipeline_result.edges

    # ── Auto-pilot: pipeline-driven decision ──
    if pipeline_result and pipeline_result.enabled:
        # Momentum analysis: sharp velocity moves → direct execution (no decider)
        vel_cfg = cfg.get("velocity", {})
        momentum_items = []
        momentum_api_cost = 0
        if vel_cfg.get("momentum_enabled", False) and pipeline_result.edges:
            momentum_items, momentum_api_cost = _analyze_momentum_opportunities(
                conn, cycle_id, pipeline_result, cfg
            )

        if momentum_items:
            log.info(f"Cycle {cycle_id}: {len(momentum_items)} momentum candidates — executing directly")
            result = _execute_momentum_bets(conn, cycle_id, momentum_items, context)
            result["total_cost"] += momentum_api_cost  # Include all Haiku calls (even skipped signals)
        else:
            # Auto-hold — include any Haiku costs from validation calls that all got skipped
            result = {
                "cycle_id": cycle_id,
                "action": "hold",
                "reasoning": "auto-hold: no velocity signals passed validation",
                "rounds": 0,
                "total_cost": momentum_api_cost,
            }
            log.info(f"Cycle {cycle_id}: auto-hold (no momentum signals)")
    else:
        # ── Fallback: legacy tool-use loop ──
        log.info(f"Cycle {cycle_id}: pipeline disabled/failed — using tool loop")
        system_prompt = build_system_prompt(conn)
        result = _run_tool_loop(conn, cycle_id, system_prompt, context, cfg)

    # Update cycle record
    balance_after = ledger.get_balance(conn)
    conn.execute(
        "UPDATE cycles SET ts_end = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
        "action = ?, reasoning = ?, total_cost = ?, rounds_used = ?, balance_after = ? "
        "WHERE id = ?",
        (result.get("action"), result.get("reasoning", "")[:500],
         result["total_cost"], result["rounds"], balance_after, cycle_id),
    )
    conn.commit()

    # Record objectives snapshot with MTM positions value
    burn_rate = ledger.get_burn_rate(conn)
    runway = ledger.get_runway(conn)
    total_pnl = ledger.get_total_pnl(conn)
    positions_value = 0.0
    for pred in ledger.get_open_predictions(conn):
        odds = odds_cache.get(pred["market_id"]) or get_current_odds(conn, pred["market_id"])
        if odds:
            cp = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
            positions_value += pred["shares"] * cp
        else:
            positions_value += pred["cost_basis"]
    positions_value = round(positions_value, 6)
    conn.execute(
        "INSERT INTO objectives (balance, burn_rate, runway_days, total_pnl, positions_value) VALUES (?, ?, ?, ?, ?)",
        (balance_after, burn_rate, runway, total_pnl, positions_value),
    )
    conn.commit()

    # Update peak total value if new high (for drawdown circuit-breaker)
    from vault.db import get_meta, set_meta
    total_value_now = balance_after + positions_value
    peak_str = get_meta(conn, "peak_total_value")
    if peak_str is None or total_value_now > float(peak_str):
        set_meta(conn, "peak_total_value", str(round(total_value_now, 6)))

    log.info(
        f"Cycle {cycle_id} complete: {result.get('action')} | "
        f"Rounds: {result['rounds']} | Cost: ${result['total_cost']:.4f} | "
        f"Balance: ${balance_after:.2f}"
    )

    return result
