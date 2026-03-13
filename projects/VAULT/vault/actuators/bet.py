"""Bet actuator — place a prediction market bet at current odds."""

import logging
from vault.actuators.base import BaseActuator
from vault import ledger
from vault.polymarket import fetch_market
from vault.config_loader import load_config

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

        # Opportunity cost gate — don't buy if remaining return < risk-free
        from vault.agent import _remaining_return_pct, _days_to_resolution
        cfg = load_config()
        vel_cfg = cfg.get("velocity", {})
        remaining = _remaining_return_pct(odds)
        days = _days_to_resolution(market.get("end_date"),
                                    vel_cfg.get("opportunity_cost_default_days", 30))
        risk_free = vel_cfg.get("opportunity_cost_annual", 0.10) * (days / 365)
        if remaining <= risk_free:
            return {
                "success": False,
                "error": f"Opportunity cost: remaining {remaining:.2%} < risk-free {risk_free:.2%} ({days:.0f}d)",
            }

        # Look up edge data from pipeline if available
        entry_edge = None
        entry_confidence = None
        entry_reasoning_text = None
        pipeline_edges = context.get("pipeline_edges", [])
        for pe in reversed(pipeline_edges):
            if pe.get("market_id") == market_id:
                entry_edge = pe.get("edge")
                entry_confidence = pe.get("confidence")
                entry_reasoning_text = pe.get("reasoning")
                break

        # Determine execution mode
        cfg = load_config()
        is_simulated = cfg.get("trading", {}).get("simulated", True)

        if not is_simulated:
            # ── Real CLOB execution ──
            from vault.clob_client import buy_shares, resolve_token_id

            token_id = resolve_token_id(market.get("clob_token_ids"), side)
            if not token_id:
                return {"success": False, "error": "Market missing CLOB token IDs — cannot place real order"}

            clob_cfg = cfg.get("trading", {}).get("clob", {})
            slippage = clob_cfg.get("slippage_pct", 0.02)
            max_price = min(odds + slippage, 0.99)
            fill = buy_shares(token_id, amount_usd, max_price=max_price)

            if not fill.success:
                fallback = clob_cfg.get("fallback_on_failure", "skip")
                if fallback == "skip":
                    return {"success": False, "error": f"CLOB order failed: {fill.error}"}
                # fallback == "paper" — fall through to paper path below
                log.warning(f"CLOB order failed, falling back to paper: {fill.error}")
            else:
                # Record with real fill data
                prediction_id = ledger.record_prediction_buy(
                    conn,
                    market_id=market_id,
                    condition_id=market.get("condition_id"),
                    question=market["question"],
                    slug=market.get("slug"),
                    side=side,
                    amount_usd=fill.amount_usd,
                    odds=fill.avg_price,
                    clob_token_id=token_id,
                    end_date=market.get("end_date"),
                    cycle_id=context.get("cycle_id"),
                    entry_edge=entry_edge,
                    entry_confidence=entry_confidence,
                    entry_reasoning=entry_reasoning_text or reasoning,
                    execution_mode="real",
                    shares_override=fill.shares,
                )

                new_balance = ledger.get_balance(conn)
                log.info(
                    f"BET [REAL] {side} on '{market['question'][:50]}' @ {fill.avg_price:.0%} | "
                    f"${fill.amount_usd:.2f} for {fill.shares:.2f} shares | order {fill.order_id[:8]}"
                )

                return {
                    "success": True,
                    "action": "bet",
                    "execution_mode": "real",
                    "market_id": market_id,
                    "question": market["question"],
                    "side": side,
                    "odds": fill.avg_price,
                    "amount_usd": fill.amount_usd,
                    "shares": fill.shares,
                    "potential_payout": fill.shares,
                    "prediction_id": prediction_id,
                    "balance_after": new_balance,
                    "order_id": fill.order_id,
                }

        # ── Paper execution (default) ──
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
            execution_mode="paper",
        )

        new_balance = ledger.get_balance(conn)
        shares = round(amount_usd / odds, 6)

        log.info(f"BET {side} on '{market['question'][:50]}' @ {odds:.0%} | ${amount_usd:.2f} | Reasoning: {reasoning}")

        return {
            "success": True,
            "action": "bet",
            "execution_mode": "paper",
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
