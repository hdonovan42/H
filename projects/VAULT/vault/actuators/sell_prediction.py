"""Sell prediction actuator — exit a prediction early at current odds."""

import logging
from vault.actuators.base import BaseActuator
from vault import ledger
from vault.polymarket import get_current_odds
from vault.config_loader import load_config

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

        # Check if this is a real position that needs CLOB execution
        cfg = load_config()
        is_simulated = cfg.get("trading", {}).get("simulated", True)
        execution_mode = pred["execution_mode"] if "execution_mode" in pred.keys() else "paper"

        if not is_simulated and execution_mode == "real":
            # ── Real CLOB sell ──
            from vault.clob_client import sell_shares

            token_id = pred["clob_token_id"]
            if not token_id:
                return {"success": False, "error": "Real position missing clob_token_id — cannot sell via CLOB"}

            clob_cfg = cfg.get("trading", {}).get("clob", {})
            slippage = clob_cfg.get("slippage_pct", 0.02)
            min_price = max(current_odds - slippage, 0.01)
            fill = sell_shares(token_id, pred["shares"], min_price=min_price)

            if fill.success:
                # Use real fill price for P&L calculation
                current_odds = fill.avg_price
                log.info(
                    f"CLOB SELL filled for prediction {prediction_id}: "
                    f"{fill.shares:.4f} shares @ {fill.avg_price:.4f}"
                )
            else:
                log.warning(f"CLOB sell failed for prediction {prediction_id}: {fill.error}")
                return {"success": False, "error": f"CLOB sell failed: {fill.error}"}

        # Record the sell (works for both paper and real — real just uses CLOB fill price)
        try:
            pnl = ledger.record_prediction_sell(
                conn, prediction_id, current_odds, context.get("cycle_id")
            )
        except ValueError as e:
            return {"success": False, "error": str(e)}

        new_balance = ledger.get_balance(conn)
        sell_value = round(pred["shares"] * current_odds, 6)

        mode_tag = " [REAL]" if execution_mode == "real" else ""
        log.info(
            f"SOLD{mode_tag} prediction {prediction_id} '{pred['question'][:40]}' "
            f"@ {current_odds:.0%} | P&L: ${pnl:+.2f} | Reasoning: {reasoning}"
        )

        return {
            "success": True,
            "action": "sell_prediction",
            "execution_mode": execution_mode,
            "prediction_id": prediction_id,
            "question": pred["question"],
            "side": pred["side"],
            "entry_odds": pred["entry_odds"],
            "exit_odds": current_odds,
            "sell_value": sell_value,
            "pnl": pnl,
            "balance_after": new_balance,
        }
