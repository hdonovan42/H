"""Agent core — auto-pilot with pipeline-driven decisions. The brain of VAULT."""

import json
import logging
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault.prompts import build_system_prompt, build_decider_prompt
from vault.actuators import get_tool_schemas, get_actuator, ACTUATOR_MAP
from vault import ledger
from vault.guardrails import check_death, check_cycle_cost, check_trade_allowed
from vault.polymarket import check_resolution
from vault.pipeline import run_pipeline

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
            except ValueError as e:
                log.warning(f"Failed to resolve prediction {pred['id']}: {e}")


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


def run_cycle(conn) -> dict:
    """Run one agent decision cycle. Returns summary dict.

    Auto-pilot mode: only calls the decider when the pipeline finds something
    actionable (bet opportunity or exit signal). Otherwise auto-holds for $0.
    Falls back to the legacy tool-use loop if the pipeline is disabled or fails.
    """
    cfg = load_config()

    # Resolve any settled predictions before the cycle starts
    resolve_predictions(conn)

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
        actionable = _get_actionable(pipeline_result)

        if not actionable:
            # Auto-hold — no Claude call, $0 cost
            result = {
                "cycle_id": cycle_id,
                "action": "hold",
                "reasoning": "auto-hold: pipeline found no actionable opportunities",
                "rounds": 0,
                "total_cost": 0,
            }
            log.info(f"Cycle {cycle_id}: auto-hold (no actionable edges)")
        else:
            log.info(f"Cycle {cycle_id}: {len(actionable)} actionable items — calling decider")
            result = _run_decider(conn, cycle_id, pipeline_result, actionable, context, cfg)
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

    # Record objectives snapshot
    burn_rate = ledger.get_burn_rate(conn)
    runway = ledger.get_runway(conn)
    total_pnl = ledger.get_total_pnl(conn)
    conn.execute(
        "INSERT INTO objectives (balance, burn_rate, runway_days, total_pnl) VALUES (?, ?, ?, ?)",
        (balance_after, burn_rate, runway, total_pnl),
    )
    conn.commit()

    log.info(
        f"Cycle {cycle_id} complete: {result.get('action')} | "
        f"Rounds: {result['rounds']} | Cost: ${result['total_cost']:.4f} | "
        f"Balance: ${balance_after:.2f}"
    )

    return result
