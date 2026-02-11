"""Actuator registry — aggregates all tools for Claude."""

from vault.config_loader import load_config
from vault.actuators.hold import HoldActuator
from vault.actuators.wait import WaitActuator
from vault.actuators.bet import BetActuator
from vault.actuators.sell_prediction import SellPredictionActuator
from vault.actuators.research_markets import ResearchMarketsActuator

# write_memory is defined here as a simple actuator
from vault.actuators.base import BaseActuator


class WriteMemoryActuator(BaseActuator):
    name = "write_memory"
    description = (
        "Write a strategy note to your persistent memory. Future versions of you will see this. "
        "Use to record lessons, observations, and rules. Categories: strategy, observation, lesson, rule. "
        "This is NOT a terminal action — you must still make a trading decision after."
    )
    parameters = {
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "enum": ["strategy", "observation", "lesson", "rule"],
                "description": "Category of this memory",
            },
            "content": {
                "type": "string",
                "description": "The memory content (keep concise to save future token costs)",
            },
            "relevance": {
                "type": "number",
                "description": "Relevance score 0.0-1.0 (higher = more important, shown first)",
            },
        },
        "required": ["category", "content"],
    }

    @property
    def terminal(self) -> bool:
        return False

    def execute(self, conn, params: dict, context: dict) -> dict:
        from vault.memory import write_memory
        mem_id = write_memory(
            conn,
            category=params["category"],
            content=params["content"],
            relevance=params.get("relevance", 1.0),
        )
        return {"success": True, "action": "write_memory", "memory_id": mem_id}


# Registry — only load crypto actuators when allowed_assets is non-empty
_cfg = load_config()
_crypto_enabled = bool(_cfg["trading"]["allowed_assets"])

ALL_ACTUATORS = []
if _crypto_enabled:
    from vault.actuators.buy import BuyActuator
    from vault.actuators.sell import SellActuator
    from vault.actuators.research import ResearchActuator
    ALL_ACTUATORS.extend([BuyActuator(), SellActuator(), ResearchActuator()])

ALL_ACTUATORS.extend([
    HoldActuator(),
    WaitActuator(),
    WriteMemoryActuator(),
    BetActuator(),
    SellPredictionActuator(),
    ResearchMarketsActuator(),
])

ACTUATOR_MAP = {a.name: a for a in ALL_ACTUATORS}


def get_tool_schemas() -> list[dict]:
    """Get all tool schemas for Claude API."""
    return [a.to_tool_schema() for a in ALL_ACTUATORS]


def get_actuator(name: str) -> BaseActuator | None:
    return ACTUATOR_MAP.get(name)
