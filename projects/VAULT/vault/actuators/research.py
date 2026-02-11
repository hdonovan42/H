"""Research actuator — fetch market data (non-terminal, returns to Claude)."""

import json
import logging
from vault.actuators.base import BaseActuator
from vault.market_data import get_price, get_all_prices

log = logging.getLogger("vault.actuator.research")


class ResearchActuator(BaseActuator):
    name = "research"
    description = (
        "Query current market data for analysis. Returns price, 24h change, and source. "
        "WARNING: After this tool returns, you will make another API call to process the data — "
        "that call costs money. Only research if you genuinely need the data to make a decision. "
        "This is NOT a terminal action — you must follow up with buy/sell/hold/wait."
    )
    parameters = {
        "type": "object",
        "properties": {
            "asset": {
                "type": "string",
                "description": "Asset to research (BTC, ETH, SOL) or 'all' for all assets",
            },
        },
        "required": ["asset"],
    }

    @property
    def terminal(self) -> bool:
        return False  # Returns data to Claude for further processing

    def execute(self, conn, params: dict, context: dict) -> dict:
        asset = params.get("asset", "all")

        if asset == "all":
            prices = get_all_prices(conn)
            log.info(f"Research: fetched all prices ({len(prices)} assets)")
            return {
                "success": True,
                "action": "research",
                "data": {k: {"price": v["price"], "change_24h_pct": v.get("change_24h_pct"), "source": v["source"]} for k, v in prices.items()},
            }
        else:
            data = get_price(conn, asset.upper())
            if not data:
                return {"success": False, "error": f"Could not fetch price for {asset}"}

            log.info(f"Research: {asset} = ${data['price']:,.2f}")
            return {
                "success": True,
                "action": "research",
                "data": {
                    asset.upper(): {
                        "price": data["price"],
                        "change_24h_pct": data.get("change_24h_pct"),
                        "source": data["source"],
                    }
                },
            }
