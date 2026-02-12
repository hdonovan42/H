"""Agent core — decision loop with tool_use. The brain of VAULT."""

import json
import logging
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault.prompts import build_system_prompt, build_edge_prompt
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


def run_cycle(conn) -> dict:
    """Run one agent decision cycle. Returns summary dict."""
    cfg = load_config()
    max_rounds = cfg["agent"]["max_rounds_per_cycle"]

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
            log.error(f"Pipeline failed, falling back to standard prompt: {e}")

    # Build system prompt — edge-based if pipeline ran, standard otherwise
    if pipeline_result and pipeline_result.enabled:
        system_prompt = build_edge_prompt(conn, pipeline_result)
    else:
        system_prompt = build_system_prompt(conn)

    messages = [
        {"role": "user", "content": "What is your decision this cycle? Review the trending prediction markets and your open positions."}
    ]

    tools = get_tool_schemas()
    result = {"cycle_id": cycle_id, "action": None, "rounds": 0, "total_cost": 0}

    for round_num in range(1, max_rounds + 1):
        # Death check before each call
        if check_death(conn):
            result["action"] = "death"
            break

        # Cost circuit breaker
        if check_cycle_cost(conn, cycle_id):
            log.warning(f"Cycle {cycle_id} hit cost limit, forcing wait")
            result["action"] = "wait (cost limit)"
            break

        # Call Claude
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

        # Death check after API call
        if check_death(conn):
            result["action"] = "death"
            break

        # Process response
        tool_calls = [b for b in response["content"] if b["type"] == "tool_use"]
        text_blocks = [b for b in response["content"] if b["type"] == "text"]

        if not tool_calls:
            # Claude didn't use a tool — treat as hold with text reasoning
            reasoning = " ".join(b["text"] for b in text_blocks)
            log.warning(f"No tool call in round {round_num}, treating as hold: {reasoning[:100]}")
            result["action"] = "hold"
            result["reasoning"] = reasoning
            break

        # Process first tool call (execute it), provide tool_result for ALL
        tool_call = tool_calls[0]
        actuator = get_actuator(tool_call["name"])

        # Build tool_results for all tool_use blocks (API requires one per tool_use)
        def _build_tool_results(primary_id, primary_result, all_calls):
            """Return tool_result list covering every tool_use block."""
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

        # Guardrail check for buy
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

        # Guardrail check for bet (prediction markets)
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

        # Execute actuator
        exec_result = actuator.execute(conn, tool_call["input"], context)

        if actuator.terminal:
            # Cycle is done
            result["action"] = tool_call["name"]
            result["reasoning"] = tool_call["input"].get("reasoning", "")
            result["exec_result"] = exec_result
            break
        else:
            # Non-terminal — send result back to Claude
            messages.append({"role": "assistant", "content": response["content"]})
            messages.append({
                "role": "user",
                "content": _build_tool_results(tool_call["id"], exec_result, tool_calls),
            })

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
