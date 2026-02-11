"""Hold actuator — deliberate no-trade decision (logged)."""

import logging
from vault.actuators.base import BaseActuator

log = logging.getLogger("vault.actuator.hold")


class HoldActuator(BaseActuator):
    name = "hold"
    description = (
        "Deliberately choose to take no trading action this cycle. "
        "Use this when you've analyzed the market and decided the best move is to do nothing. "
        "Your reasoning is logged. This is a terminal action."
    )
    parameters = {
        "type": "object",
        "properties": {
            "reasoning": {
                "type": "string",
                "description": "Why you are choosing to hold (logged for review)",
            },
        },
        "required": ["reasoning"],
    }

    def execute(self, conn, params: dict, context: dict) -> dict:
        reasoning = params.get("reasoning", "")
        log.info(f"HOLD: {reasoning}")
        return {
            "success": True,
            "action": "hold",
            "reasoning": reasoning,
            "balance": context.get("balance", 0),
        }
