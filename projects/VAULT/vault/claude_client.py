"""Anthropic SDK wrapper — logs cost on every call, deducts from balance."""

import json
import logging
from anthropic import Anthropic
from vault.config_loader import load_config
from vault.cost_tracker import calculate_cost

log = logging.getLogger("vault.claude")

_client = None


def get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(timeout=120.0)  # uses ANTHROPIC_API_KEY env var
    return _client


def call_claude(
    *,
    conn,
    ledger_mod,
    model: str | None = None,
    system: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    cycle_id: int | None = None,
    purpose: str = "decision",
) -> dict:
    """Call Claude API, log cost, deduct from balance. Returns full response dict.

    Raises RuntimeError if balance insufficient after deduction (death).
    """
    cfg = load_config()
    if model is None:
        model = cfg["agent"]["default_model"]

    client = get_client()

    kwargs = {
        "model": model,
        "max_tokens": 1024,
        "system": system,
        "messages": messages,
    }
    if tools:
        kwargs["tools"] = tools

    response = client.messages.create(**kwargs)

    # Calculate cost
    input_tokens = response.usage.input_tokens
    output_tokens = response.usage.output_tokens
    cost = calculate_cost(model, input_tokens, output_tokens)

    log.info(f"API call: {model} | {input_tokens}in/{output_tokens}out | ${cost:.4f} | {purpose}")

    # Log to api_calls table
    conn.execute(
        "INSERT INTO api_calls (cycle_id, model, input_tokens, output_tokens, cost_usd, purpose) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (cycle_id, model, input_tokens, output_tokens, cost, purpose),
    )
    conn.commit()

    # Deduct from balance
    ledger_mod.deduct_api_cost(conn, cost, f"{model} | {purpose}")

    # Convert response to workable dict
    result = {
        "id": response.id,
        "model": response.model,
        "stop_reason": response.stop_reason,
        "content": [],
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        },
        "cost": cost,
    }

    for block in response.content:
        if block.type == "text":
            result["content"].append({"type": "text", "text": block.text})
        elif block.type == "tool_use":
            result["content"].append({
                "type": "tool_use",
                "id": block.id,
                "name": block.name,
                "input": block.input,
            })

    return result
