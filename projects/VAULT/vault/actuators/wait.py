"""Wait actuator — skip cycle entirely (cheapest option)."""

import logging
from vault.actuators.base import BaseActuator

log = logging.getLogger("vault.actuator.wait")


class WaitActuator(BaseActuator):
    name = "wait"
    description = (
        "Skip this cycle entirely without further analysis. This is the cheapest action — "
        "it ends the cycle immediately with no additional API calls. Use when there's nothing "
        "worth investigating. This is a terminal action."
    )
    parameters = {
        "type": "object",
        "properties": {
            "reasoning": {
                "type": "string",
                "description": "Brief note on why you're waiting",
            },
        },
        "required": ["reasoning"],
    }

    def execute(self, conn, params: dict, context: dict) -> dict:
        reasoning = params.get("reasoning", "")
        log.info(f"WAIT: {reasoning}")
        return {
            "success": True,
            "action": "wait",
            "reasoning": reasoning,
            "balance": context.get("balance", 0),
        }
