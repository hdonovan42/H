"""Research markets actuator — browse trending markets, search, or view portfolio."""

import logging
from vault.actuators.base import BaseActuator
from vault.polymarket import fetch_trending, search_markets, fetch_market
from vault import ledger
from vault.polymarket import get_current_odds

log = logging.getLogger("vault.actuator.research_markets")


class ResearchMarketsActuator(BaseActuator):
    name = "research_markets"
    description = (
        "Browse Polymarket prediction markets. Use mode='trending' to see top markets by volume, "
        "'search' to find markets by keyword, or 'portfolio' to see your open predictions with current odds. "
        "WARNING: After this tool returns, you make another API call — that costs money. "
        "This is NOT a terminal action — you must follow up with bet/sell_prediction/buy/sell/hold/wait."
    )
    parameters = {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["trending", "search", "portfolio"],
                "description": "What to look up",
            },
            "query": {
                "type": "string",
                "description": "Search query (required if mode is 'search')",
            },
        },
        "required": ["mode"],
    }

    @property
    def terminal(self) -> bool:
        return False

    def execute(self, conn, params: dict, context: dict) -> dict:
        mode = params.get("mode", "trending")

        if mode == "trending":
            markets = fetch_trending(conn)
            log.info(f"Research markets: fetched {len(markets)} trending")
            return {
                "success": True,
                "action": "research_markets",
                "mode": "trending",
                "markets": [
                    {
                        "id": m["id"],
                        "question": m["question"],
                        "yes_price": m["yes_price"],
                        "no_price": m["no_price"],
                        "volume": m["volume"],
                        "end_date": m["end_date"],
                    }
                    for m in markets
                ],
            }

        elif mode == "search":
            query = params.get("query", "")
            if not query:
                return {"success": False, "error": "Query required for search mode"}
            markets = search_markets(conn, query)
            log.info(f"Research markets: searched '{query}', found {len(markets)}")
            return {
                "success": True,
                "action": "research_markets",
                "mode": "search",
                "query": query,
                "markets": [
                    {
                        "id": m["id"],
                        "question": m["question"],
                        "yes_price": m["yes_price"],
                        "no_price": m["no_price"],
                        "volume": m["volume"],
                        "end_date": m["end_date"],
                    }
                    for m in markets
                ],
            }

        elif mode == "portfolio":
            predictions = ledger.get_open_predictions(conn)
            enriched = []
            for p in predictions:
                odds = get_current_odds(conn, p["market_id"])
                current = odds["yes_price"] if p["side"] == "YES" else odds["no_price"] if odds else p["entry_odds"]
                market_value = round(p["shares"] * current, 6)
                enriched.append({
                    "prediction_id": p["id"],
                    "question": p["question"],
                    "side": p["side"],
                    "shares": p["shares"],
                    "entry_odds": p["entry_odds"],
                    "current_odds": current,
                    "cost_basis": p["cost_basis"],
                    "market_value": market_value,
                    "unrealized_pnl": round(market_value - p["cost_basis"], 6),
                    "end_date": p["end_date"],
                })
            log.info(f"Research markets: portfolio ({len(enriched)} open predictions)")
            return {
                "success": True,
                "action": "research_markets",
                "mode": "portfolio",
                "predictions": enriched,
            }

        return {"success": False, "error": f"Unknown mode: {mode}"}
