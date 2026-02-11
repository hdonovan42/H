"""Sell prediction actuator — exit a prediction early at current odds."""

import logging
from vault.actuators.base import BaseActuator
from vault import ledger
from vault.polymarket import get_current_odds

log = logging.getLogger("vault.actuator.sell_prediction")


class SellPredictionActuator(BaseActuator):
    name = "sell_prediction"
    description = (
        "Exit an open prediction market position early at current odds. "
        "Your shares are sold at the current probability price for your side. "
        "Use this to lock in profits or cut losses before market resolution. "
        "This is a terminal action."
    )
    parameters = {
        "type": "object",
        "properties": {
            "prediction_id": {
                "type": "integer",
                "description": "ID of the open prediction to sell (from your predictions list)",
            },
            "reasoning": {
                "type": "string",
                "description": "Why you are exiting this prediction (logged for review)",
            },
        },
        "required": ["prediction_id", "reasoning"],
    }

    def execute(self, conn, params: dict, context: dict) -> dict:
        prediction_id = params["prediction_id"]
        reasoning = params.get("reasoning", "")

        pred = conn.execute(
            "SELECT * FROM predictions WHERE id = ? AND status = 'open'",
            (prediction_id,),
        ).fetchone()

        if not pred:
            return {"success": False, "error": f"No open prediction with ID {prediction_id}"}

        # Get current odds
        odds_data = get_current_odds(conn, pred["market_id"])
        if not odds_data:
            return {"success": False, "error": f"Could not fetch current odds for market {pred['market_id']}"}

        current_odds = odds_data["yes_price"] if pred["side"] == "YES" else odds_data["no_price"]

        try:
            pnl = ledger.record_prediction_sell(
                conn, prediction_id, current_odds, context.get("cycle_id")
            )
        except ValueError as e:
            return {"success": False, "error": str(e)}

        new_balance = ledger.get_balance(conn)
        sell_value = round(pred["shares"] * current_odds, 6)

        log.info(
            f"SOLD prediction {prediction_id} '{pred['question'][:40]}' "
            f"@ {current_odds:.0%} | P&L: ${pnl:+.2f} | Reasoning: {reasoning}"
        )

        return {
            "success": True,
            "action": "sell_prediction",
            "prediction_id": prediction_id,
            "question": pred["question"],
            "side": pred["side"],
            "entry_odds": pred["entry_odds"],
            "exit_odds": current_odds,
            "sell_value": sell_value,
            "pnl": pnl,
            "balance_after": new_balance,
        }
