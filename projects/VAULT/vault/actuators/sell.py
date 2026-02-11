"""Sell actuator — close an open position at market price."""

import logging
from vault.actuators.base import BaseActuator
from vault import ledger

log = logging.getLogger("vault.actuator.sell")


class SellActuator(BaseActuator):
    name = "sell"
    description = (
        "Sell/close an open position at current market price. Specify the position ID. "
        "The proceeds are added to your balance. This is a terminal action."
    )
    parameters = {
        "type": "object",
        "properties": {
            "position_id": {
                "type": "integer",
                "description": "ID of the open position to sell (from your positions list)",
            },
            "reasoning": {
                "type": "string",
                "description": "Why you are closing this position (logged for review)",
            },
        },
        "required": ["position_id", "reasoning"],
    }

    def execute(self, conn, params: dict, context: dict) -> dict:
        position_id = params["position_id"]
        reasoning = params.get("reasoning", "")

        # Get position details
        pos = conn.execute(
            "SELECT * FROM positions WHERE id = ? AND status = 'open'",
            (position_id,),
        ).fetchone()

        if not pos:
            return {"success": False, "error": f"No open position with ID {position_id}"}

        asset = pos["asset"]
        prices = context.get("prices", {})
        if asset not in prices:
            return {"success": False, "error": f"No price available for {asset}"}

        price = prices[asset]["price"]

        try:
            pnl = ledger.record_trade_sell(conn, position_id, price, context.get("cycle_id"))
        except ValueError as e:
            return {"success": False, "error": str(e)}

        new_balance = ledger.get_balance(conn)
        log.info(f"SELL executed: position {position_id} ({asset}) @ ${price:,.2f} | P&L: ${pnl:+.2f} | Reasoning: {reasoning}")

        return {
            "success": True,
            "action": "sell",
            "asset": asset,
            "quantity": pos["quantity"],
            "price": price,
            "pnl": pnl,
            "position_id": position_id,
            "balance_after": new_balance,
        }
