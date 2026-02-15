"""Bet actuator — place a prediction market bet at current odds."""

import logging
from vault.actuators.base import BaseActuator
from vault import ledger
from vault.polymarket import fetch_market

log = logging.getLogger("vault.actuator.bet")


class BetActuator(BaseActuator):
    name = "bet"
    description = (
        "Place a prediction market bet on Polymarket. Specify the market_id, side (YES/NO), "
        "and USD amount. You buy shares at current odds — if the market resolves in your favor, "
        "each share pays out $1. If you lose, you get $0. This is a terminal action."
    )
    parameters = {
        "type": "object",
        "properties": {
            "market_id": {
                "type": "string",
                "description": "Polymarket market ID (from trending markets or research_markets)",
            },
            "side": {
                "type": "string",
                "enum": ["YES", "NO"],
                "description": "Which outcome to bet on",
            },
            "amount_usd": {
                "type": "number",
                "description": "USD amount to bet",
            },
            "reasoning": {
                "type": "string",
                "description": "Why you are making this bet (logged for review)",
            },
        },
        "required": ["market_id", "side", "amount_usd", "reasoning"],
    }

    def execute(self, conn, params: dict, context: dict) -> dict:
        market_id = params["market_id"]
        side = params["side"].upper()
        amount_usd = params["amount_usd"]
        reasoning = params.get("reasoning", "")

        if side not in ("YES", "NO"):
            return {"success": False, "error": "Side must be YES or NO"}

        if amount_usd <= 0:
            return {"success": False, "error": "Amount must be positive"}

        balance = ledger.get_balance(conn)
        if amount_usd > balance:
            return {"success": False, "error": f"Insufficient balance. Want ${amount_usd:.2f}, have ${balance:.2f}"}

        # Fetch current market data
        market = fetch_market(conn, market_id)
        if not market:
            return {"success": False, "error": f"Could not fetch market {market_id}"}

        if market.get("closed"):
            return {"success": False, "error": "Market is already closed"}

        odds = market["yes_price"] if side == "YES" else market["no_price"]
        if odds <= 0 or odds >= 1:
            return {"success": False, "error": f"Invalid odds: {odds}"}

        # Look up edge data from pipeline if available
        entry_edge = None
        entry_confidence = None
        entry_reasoning_text = None
        pipeline_edges = context.get("pipeline_edges", [])
        for pe in pipeline_edges:
            if pe.get("market_id") == market_id:
                entry_edge = pe.get("edge")
                entry_confidence = pe.get("confidence")
                entry_reasoning_text = pe.get("reasoning")
                break

        prediction_id = ledger.record_prediction_buy(
            conn,
            market_id=market_id,
            condition_id=market.get("condition_id"),
            question=market["question"],
            slug=market.get("slug"),
            side=side,
            amount_usd=amount_usd,
            odds=odds,
            clob_token_id=None,
            end_date=market.get("end_date"),
            cycle_id=context.get("cycle_id"),
            entry_edge=entry_edge,
            entry_confidence=entry_confidence,
            entry_reasoning=entry_reasoning_text or reasoning,
        )

        new_balance = ledger.get_balance(conn)
        shares = round(amount_usd / odds, 6)

        log.info(f"BET {side} on '{market['question'][:50]}' @ {odds:.0%} | ${amount_usd:.2f} | Reasoning: {reasoning}")

        return {
            "success": True,
            "action": "bet",
            "market_id": market_id,
            "question": market["question"],
            "side": side,
            "odds": odds,
            "amount_usd": amount_usd,
            "shares": shares,
            "potential_payout": shares,
            "prediction_id": prediction_id,
            "balance_after": new_balance,
        }
