"""Buy actuator — purchase asset at market price."""

import logging
from vault.actuators.base import BaseActuator
from vault import ledger

log = logging.getLogger("vault.actuator.buy")


class BuyActuator(BaseActuator):
    name = "buy"
    description = (
        "Buy an asset at current market price. Specify the asset symbol and USD amount to spend. "
        "The cost is deducted from your balance immediately. This is a terminal action."
    )
    parameters = {
        "type": "object",
        "properties": {
            "asset": {
                "type": "string",
                "description": "Asset symbol (BTC, ETH, SOL)",
                "enum": ["BTC", "ETH", "SOL"],
            },
            "amount_usd": {
                "type": "number",
                "description": "USD amount to spend on this purchase",
            },
            "reasoning": {
                "type": "string",
                "description": "Why you are making this trade (logged for review)",
            },
        },
        "required": ["asset", "amount_usd", "reasoning"],
    }

    def execute(self, conn, params: dict, context: dict) -> dict:
        asset = params["asset"]
        amount_usd = params["amount_usd"]
        reasoning = params.get("reasoning", "")

        prices = context.get("prices", {})
        if asset not in prices:
            return {"success": False, "error": f"No price available for {asset}"}

        price = prices[asset]["price"]
        balance = ledger.get_balance(conn)

        if amount_usd > balance:
            return {"success": False, "error": f"Insufficient balance. Want ${amount_usd:.2f}, have ${balance:.2f}"}

        if amount_usd <= 0:
            return {"success": False, "error": "Amount must be positive"}

        quantity = amount_usd / price
        position_id = ledger.record_trade_buy(
            conn, asset, quantity, price, amount_usd, context.get("cycle_id")
        )

        new_balance = ledger.get_balance(conn)
        log.info(f"BUY executed: {quantity:.8f} {asset} @ ${price:,.2f} | Reasoning: {reasoning}")

        return {
            "success": True,
            "action": "buy",
            "asset": asset,
            "quantity": quantity,
            "price": price,
            "amount_usd": amount_usd,
            "position_id": position_id,
            "balance_after": new_balance,
        }
