"""Cost calculation from Anthropic API usage."""

from vault.config_loader import load_config


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Calculate USD cost from token counts using config pricing."""
    cfg = load_config()
    pricing = cfg.get("pricing", {})

    if model not in pricing:
        # Fallback: assume Opus pricing (most expensive = safe)
        rates = pricing.get("claude-opus-4-6", {"input": 15.0, "output": 75.0})
    else:
        rates = pricing[model]

    cost = (input_tokens * rates["input"] / 1_000_000) + (
        output_tokens * rates["output"] / 1_000_000
    )
    return round(cost, 6)


def format_cost(cost: float) -> str:
    """Format cost for display."""
    if cost < 0.01:
        return f"${cost:.4f}"
    return f"${cost:.2f}"
