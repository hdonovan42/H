"""Agent core — auto-pilot with pipeline-driven decisions. The brain of VAULT."""

import json
import logging
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault.prompts import build_system_prompt, build_decider_prompt, build_momentum_prompt
from vault.actuators import get_tool_schemas, get_actuator, ACTUATOR_MAP
from vault import ledger
from vault.guardrails import check_death, check_cycle_cost, check_trade_allowed
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


def _get_actionable(pipeline_result) -> list[dict] | None:
    """Check pipeline result for actionable opportunities.

    Returns a list of actionable items (bet edges, exit signals, sentinel breaks),
    or None if there's nothing for the decider to decide on.
    """
    if not pipeline_result or not pipeline_result.enabled:
        return None

    items = []

    # Check edges for bet or exit signals
    for edge in (pipeline_result.edges or []):
        if edge.get("action") in ("bet", "exit"):
            items.append(edge)

    # Check sentinel for BROKEN alerts (may not have a corresponding edge)
    sentinel = pipeline_result.sentinel_results or {}
    for alert in sentinel.get("position_alerts", []):
        if alert.get("status") == "BROKEN":
            # Only add if not already covered by an exit edge
            pred_id = alert.get("prediction_id")
            already_covered = any(
                e.get("action") == "exit" and e.get("prediction_id") == pred_id
                for e in items
            )
            if not already_covered:
                items.append({
                    "action": "exit",
                    "prediction_id": pred_id,
                    "reasoning": f"Sentinel: thesis broken — {alert.get('event', 'unknown')}",
                    "source": "sentinel",
                })

    # Log velocity alerts (can't bet without estimate, but surface for awareness)
    velocity_alerts = [
        e for e in (pipeline_result.edges or [])
        if e.get("action") == "velocity_alert" and e.get("velocity_sharp")
    ]
    for va in velocity_alerts:
        log.info(
            f"Velocity alert (no estimate): {va.get('question', va['market_id'])[:60]} — "
            f"{va.get('reasoning', '')[:100]}"
        )

    return items if items else None


def _run_decider(conn, cycle_id, pipeline_result, actionable, context, cfg) -> dict:
    """Call Haiku once with focused prompt, parse JSON, execute actions directly.

    Returns a cycle result dict with action, reasoning, rounds, total_cost.
    """
    result = {"cycle_id": cycle_id, "action": None, "rounds": 1, "total_cost": 0}

    # Death check before call
    if check_death(conn):
        result["action"] = "death"
        result["rounds"] = 0
        return result

    system_prompt, user_prompt = build_decider_prompt(conn, pipeline_result, actionable)

    response = call_claude(
        conn=conn,
        ledger_mod=ledger,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
        cycle_id=cycle_id,
        purpose=f"decider",
        max_tokens=512,
    )
    result["total_cost"] = response["cost"]

    # Death check after call
    if check_death(conn):
        result["action"] = "death"
        return result

    # Parse JSON response
    text = " ".join(b["text"] for b in response["content"] if b["type"] == "text")
    actions = _parse_decider_json(text)

    if not actions:
        log.warning(f"Decider returned unparseable response, treating as hold: {text[:200]}")
        result["action"] = "hold"
        result["reasoning"] = f"decider parse error: {text[:200]}"
        return result

    # Execute the first actionable decision (bet/sell/hold)
    executed = False
    for decision in actions:
        action = decision.get("action", "hold")
        reasoning = decision.get("reasoning", "")

        if action == "bet":
            market_id = decision.get("market_id")
            side = decision.get("side", "YES")
            amount_usd = decision.get("amount_usd", 0)

            # Guardrail check
            allowed, block_reason = check_trade_allowed(conn, amount_usd, "PREDICTION")
            if not allowed:
                log.warning(f"Decider bet blocked by guardrail: {block_reason}")
                result["action"] = "hold"
                result["reasoning"] = f"bet blocked: {block_reason}"
                executed = True
                break

            # Opportunity cost gate — don't enter if we'd immediately exit
            from vault.polymarket import get_current_odds
            opp_odds = get_current_odds(conn, market_id)
            if opp_odds:
                opp_price = opp_odds["yes_price"] if side == "YES" else opp_odds["no_price"]
                opp_cfg = cfg.get("velocity", {})
                opp_remaining = _remaining_return_pct(opp_price)
                opp_end = conn.execute(
                    "SELECT end_date FROM musk_markets WHERE market_id = ?",
                    (market_id,),
                ).fetchone()
                opp_days = _days_to_resolution(
                    opp_end[0] if opp_end else None,
                    opp_cfg.get("opportunity_cost_default_days", 30),
                )
                opp_risk_free = opp_cfg.get("opportunity_cost_annual", 0.10) * (opp_days / 365)
                if opp_price >= 0.995 or opp_remaining <= opp_risk_free:
                    log.info(
                        f"Decider bet blocked (would immediately exit): {side} on {market_id} "
                        f"@ {opp_price:.2%} — remaining {opp_remaining:.2%} vs risk-free {opp_risk_free:.2%}"
                    )
                    result["action"] = "hold"
                    result["reasoning"] = f"bet blocked: would immediately exit @ {opp_price:.2%}"
                    executed = True
                    break

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
                log.info(f"Decider: BET {side} ${amount_usd:.2f} on {market_id}")
            else:
                result["action"] = "hold"
                result["reasoning"] = f"bet failed: {exec_result.get('error', 'unknown')}"
                log.warning(f"Decider bet failed: {exec_result.get('error')}")
            executed = True
            break

        elif action == "sell":
            prediction_id = decision.get("prediction_id")

            sell_actuator = get_actuator("sell_prediction")
            exec_result = sell_actuator.execute(conn, {
                "prediction_id": prediction_id,
                "reasoning": reasoning,
            }, context)

            if exec_result.get("success"):
                result["action"] = "sell_prediction"
                result["reasoning"] = reasoning
                result["exec_result"] = exec_result
                log.info(f"Decider: SELL prediction {prediction_id}")
            else:
                result["action"] = "hold"
                result["reasoning"] = f"sell failed: {exec_result.get('error', 'unknown')}"
                log.warning(f"Decider sell failed: {exec_result.get('error')}")
            executed = True
            break

        elif action == "hold":
            result["action"] = "hold"
            result["reasoning"] = reasoning
            executed = True
            break

    if not executed:
        result["action"] = "hold"
        result["reasoning"] = "decider returned no executable actions"

    return result


def _parse_decider_json(text: str) -> list[dict] | None:
    """Parse JSON array from decider response. Tolerant of markdown fences."""
    text = text.strip()
    # Strip markdown code fences
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            return [parsed]
    except json.JSONDecodeError:
        pass

    # Try to find JSON array in the text
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    return None


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


def _analyze_momentum_opportunities(conn, cycle_id: int, pipeline_result, cfg: dict) -> list[dict]:
    """Analyze velocity alerts for pure velocity-following momentum bets.

    Direction is mechanical (from velocity sign), sizing scales with velocity
    magnitude, and Haiku validates follow/no-follow (no probability estimation).
    """
    vel_cfg = cfg.get("velocity", {})
    max_per_cycle = vel_cfg.get("max_momentum_per_cycle", 3)
    follow_confidence = vel_cfg.get("momentum_follow_confidence", 0.6)
    base_bet = vel_cfg.get("momentum_base_bet_usd", 2.00)
    max_bet = vel_cfg.get("momentum_max_bet_usd", 4.00)
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

    items = []
    total_api_cost = 0  # Track all Haiku calls including skipped signals
    for alert in velocity_alerts[:max_per_cycle]:
        question = alert.get("question", alert["market_id"])
        v_1h = alert.get("v_1h")
        v_6h = alert.get("v_6h")

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

        # 3. Velocity-scaled sizing: raw velocity sets base, z-score amplifies
        z_1h = alert.get("z_1h")
        z_sizing_high = vel_cfg.get("z_sizing_high", 4.0)
        z_sizing_low = vel_cfg.get("z_sizing_low", 3.0)
        z_boost_low = vel_cfg.get("z_boost_low", 1.5)    # multiplier at z >= z_sizing_low
        z_boost_high = vel_cfg.get("z_boost_high", 2.5)   # multiplier at z >= z_sizing_high
        abs_v = abs(v_1h)

        # Base multiplier from raw velocity (unchanged — all markets get this)
        if abs_v >= 0.40:
            vel_mult = vel_scale_40
        elif abs_v >= 0.20:
            vel_mult = vel_scale_20
        else:
            vel_mult = 1.0

        # Z-score amplifier on top: high-conviction signals get bigger positions
        if z_1h is not None:
            abs_z = abs(z_1h)
            if abs_z >= z_sizing_high:
                vel_mult *= z_boost_high
            elif abs_z >= z_sizing_low:
                vel_mult *= z_boost_low

        raw_bet = min(base_bet * vel_mult, max_bet, balance * 0.10)

        # Pyramiding: scale bet size based on unrealised ROI of existing exposure
        current_exposure = exposure_by_market.get(alert["market_id"], 0)
        current_value = value_by_market.get(alert["market_id"], 0)
        unrealised_roi = (current_value - current_exposure) / current_exposure if current_exposure > 0 else 0
        if unrealised_roi >= 0.25:
            pyramid_mult = 3.0
        elif unrealised_roi >= 0.10:
            pyramid_mult = 2.0
        else:
            pyramid_mult = 1.0

        # Cap bet size (respect remaining room under exposure cap)
        max_exposure_usd = balance * max_exposure_pct
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

        if pyramid_mult > 1:
            log.info(
                f"Momentum pyramid: {question[:40]} — ROI {unrealised_roi:+.0%} → "
                f"{pyramid_mult:.0f}x size (${bet_size:.2f})"
            )

        # 4. Position-aware validation: add vs new entry
        is_add = (alert["market_id"], side) in open_pred_by_market_side

        if is_add:
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
            # New entry — full Haiku validation
            analysis = _call_momentum_haiku(
                conn, cycle_id, question, v_1h, v_6h, market_odds,
                side, entry_price, remaining, model, cfg,
                z_1h=z_1h,
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

            total_api_cost += analysis.get("api_cost", 0)
            follow = analysis["follow"]
            conf = analysis["confidence"]
            reasoning = analysis["reasoning"]

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
        end_date = conn.execute(
            "SELECT end_date FROM musk_markets WHERE market_id = ?",
            (alert["market_id"],),
        ).fetchone()
        annual_rate = vel_cfg.get("opportunity_cost_annual", 0.10)
        default_days = vel_cfg.get("opportunity_cost_default_days", 30)
        days = _days_to_resolution(end_date[0] if end_date else None, default_days)
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
            "reasoning": f"Momentum {'add' if is_add else 'follow'}: {reasoning}",
            "recommended_size_usd": bet_size,
            "velocity_sharp": True,
            "source": "momentum",
            "api_cost": 0 if is_add else analysis.get("api_cost", 0),
        }
        items.append(item)

        _log_smart_money_event(
            conn, cycle_id=cycle_id, market_id=alert["market_id"],
            question=question,
            vel={"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": "neutral", "sharp": True},
            action_taken=action_tag,
            market_odds=market_odds, side=side, amount_usd=bet_size,
        )
        z_part = f", z={z_1h:.1f}" if z_1h is not None else ""
        log.info(
            f"Momentum {action_tag} candidate: {question[:50]} — {side} ${bet_size:.2f} "
            f"(v={v_1h:+.0%}/1h{z_part}, conf={conf:.0%})"
        )

    return items, total_api_cost


def _call_momentum_haiku(conn, cycle_id, question, v_1h, v_6h, market_odds,
                         side, entry_price, remaining, model, cfg,
                         z_1h=None):
    """Call Haiku for momentum follow/no-follow validation. Returns parsed dict or None."""
    system, user = build_momentum_prompt(
        question, v_1h, v_6h, market_odds, side, entry_price, remaining,
        z_1h=z_1h,
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
        result["action"] = "hold"
        result["reasoning"] = f"momentum bet failed: {exec_result.get('error', 'unknown')}"
        log.warning(f"Momentum bet failed: {exec_result.get('error')}")

    return result


def _remaining_return_pct(our_price: float) -> float:
    """Max possible return if position resolves in our favour."""
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


def _exit_substandard_positions(conn):
    """Exit positions that no longer meet current entry minimums.

    Applies current confidence and edge thresholds retroactively to open positions.
    Pipeline positions entered under looser rules get closed if they don't meet
    today's standards. Only applies to pipeline positions (entry_confidence > 0).
    """
    cfg = load_config()
    edge_cfg = cfg.get("edge", {})
    min_confidence = edge_cfg.get("min_confidence", 0.4)
    margin_of_safety = edge_cfg.get("margin_of_safety", 0.10)

    from vault.polymarket import get_current_odds
    open_preds = ledger.get_open_predictions(conn)
    for pred in open_preds:
        conf = pred.get("entry_confidence")
        if not conf or conf <= 0:
            continue  # legacy/momentum — not subject to intel gates

        edge = abs(pred.get("entry_edge") or 0)
        reason = None
        if conf < min_confidence:
            reason = f"confidence {conf:.2f} < {min_confidence:.2f}"
        elif edge < margin_of_safety:
            reason = f"edge {edge:.0%} < {margin_of_safety:.0%}"

        if reason:
            odds = get_current_odds(conn, pred["market_id"])
            if not odds:
                continue
            our_price = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
            try:
                pnl = ledger.record_prediction_sell(conn, pred["id"], our_price)
                log.info(
                    f"Substandard exit: [{pred['id']}] {pred['side']} "
                    f"'{pred['question'][:40]}' — {reason} — P&L: ${pnl:+.2f}"
                )
            except Exception as e:
                log.warning(f"Failed substandard exit {pred['id']}: {e}")


def _exit_opportunity_cost(conn):
    """Exit positions where remaining return < risk-free return over the same period.

    At 10% annual opportunity cost:
      - 99.5% position resolving in 30d: 0.5% remaining vs 0.82% risk-free → EXIT
      - 95% position resolving in 7d: 5.3% remaining vs 0.19% risk-free → HOLD
      - 99% position resolving in 1d: 1.0% remaining vs 0.03% risk-free → HOLD
    """
    from vault.polymarket import get_current_odds
    cfg = load_config()
    annual_rate = cfg.get("velocity", {}).get("opportunity_cost_annual", 0.10)
    default_days = cfg.get("velocity", {}).get("opportunity_cost_default_days", 30)

    open_preds = ledger.get_open_predictions(conn)
    for pred in open_preds:
        odds = get_current_odds(conn, pred["market_id"])
        if not odds:
            continue
        our_price = odds["yes_price"] if pred["side"] == "YES" else odds["no_price"]
        remaining = _remaining_return_pct(our_price)
        days = _days_to_resolution(pred.get("end_date"), default_days)
        risk_free = annual_rate * (days / 365)

        if our_price >= 0.995 or remaining <= risk_free:
            try:
                pnl = ledger.record_prediction_sell(conn, pred["id"], our_price)
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

    # Exit pipeline positions that don't meet current entry minimums
    _exit_substandard_positions(conn)

    # Exit positions where remaining return < risk-free return over same period
    _exit_opportunity_cost(conn)

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
    from vault.polymarket import get_current_odds
    positions_value = 0.0
    for pred in ledger.get_open_predictions(conn):
        odds = get_current_odds(conn, pred["market_id"])
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

    log.info(
        f"Cycle {cycle_id} complete: {result.get('action')} | "
        f"Rounds: {result['rounds']} | Cost: ${result['total_cost']:.4f} | "
        f"Balance: ${balance_after:.2f}"
    )

    return result
