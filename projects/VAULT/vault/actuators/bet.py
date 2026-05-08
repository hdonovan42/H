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

        # `closed` may be True/False/None. None means gamma didn't tell us;
        # don't fall through assuming open. accepting_orders likewise.
        if market.get("closed") is True:
            return {"success": False, "error": "Market is already closed"}
        if market.get("closed") is None:
            return {"success": False, "error": "Market closed-status unknown (gamma didn't return field)"}
        if market.get("accepting_orders") is False:
            return {"success": False, "error": "Market not accepting orders"}

        # `has_prices` is False when the gamma API returned no outcomePrices
        # for this market — refusing to bet on missing price data is the
        # whole point of v20.5.
        if not market.get("has_prices"):
            return {"success": False, "error": "Market prices unavailable from gamma"}

        odds = market["yes_price"] if side == "YES" else market["no_price"]
        if odds is None or odds <= 0 or odds >= 1:
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
            # ── Real CLOB execution (two-phase commit flow) ──
            import uuid, time
            from vault.clob_client import buy_shares, resolve_token_id, get_best_ask, get_usdc_balance, get_ctf_balance

            # PRECONDITION: VAULT must have gone live (paper ledger reset to on-chain).
            # This is the fix for the 15 March 2026 incident root cause.
            if not ledger.is_live(conn):
                log.critical(
                    "REAL MODE BLOCKED: `simulated: false` but no go_live event in DB. "
                    "Run `vault go-live` first."
                )
                return {"success": False, "error": "Real mode requires `vault go-live` — paper ledger has not been reset to on-chain balance"}

            token_id = resolve_token_id(market.get("clob_token_ids"), side)
            if not token_id:
                return {"success": False, "error": "Market missing CLOB token IDs — cannot place real order"}

            clob_cfg = cfg.get("trading", {}).get("clob", {})
            max_price = 0.99  # CLOB hard limit is 0.99

            # Guard 6: Dry-run mode — log but don't execute
            from vault.db import get_meta, set_meta
            dry_run_str = get_meta(conn, "dry_run_remaining")
            if dry_run_str and int(dry_run_str) > 0:
                remaining = int(dry_run_str)
                log.info(
                    f"DRY-RUN: WOULD bet {side} ${amount_usd:.2f} on '{market['question'][:50]}' "
                    f"@ {odds:.0%} — {remaining} dry-run cycles remaining"
                )
                set_meta(conn, "dry_run_remaining", str(remaining - 1))
                conn.commit()
                return {"success": False, "error": f"Dry-run mode ({remaining} cycles remaining)"}

            # Guard 1: Pre-trade on-chain balance gate (MUST succeed — no silent bypass)
            onchain_usdc = get_usdc_balance()
            if onchain_usdc is None:
                log.critical(
                    "PRE-TRADE HALT: RPC unavailable — cannot verify on-chain USDC. "
                    "Refusing real order; daemon will pause after N RPC failures."
                )
                return {"success": False, "error": "RPC unavailable — cannot verify on-chain USDC balance"}
            if onchain_usdc < amount_usd:
                log.critical(
                    f"PRE-TRADE HALT: on-chain USDC ${onchain_usdc:.2f} < order ${amount_usd:.2f}. "
                    f"Internal ledger says ${balance:.2f}. REFUSING order."
                )
                return {"success": False, "error": f"On-chain balance gate: ${onchain_usdc:.2f} < ${amount_usd:.2f}"}

            # Guard 1b: Real-mode position cap (max 10% of on-chain USDC per bet).
            # Never let a single bug/bug-chain nuke more than 10% of live capital.
            max_pct = clob_cfg.get("max_bet_pct_onchain", 0.10)
            onchain_cap = round(onchain_usdc * max_pct, 6)
            if amount_usd > onchain_cap:
                return {
                    "success": False,
                    "error": f"Real-mode cap: ${amount_usd:.2f} > ${onchain_cap:.2f} ({max_pct:.0%} of on-chain ${onchain_usdc:.2f})",
                }

            # Pre-flight: check orderbook has asks we can actually fill
            best_ask = get_best_ask(token_id)
            if best_ask is None or best_ask > max_price:
                return {"success": False, "error": f"No CLOB liquidity at ≤${max_price} (best ask: {best_ask})"}

            # Re-evaluate opportunity cost at CLOB ask price (not Gamma mid)
            real_remaining = _remaining_return_pct(best_ask)
            if real_remaining <= risk_free:
                return {
                    "success": False,
                    "error": f"Opportunity cost at CLOB ask: remaining {real_remaining:.2%} < risk-free {risk_free:.2%} (ask ${best_ask:.2f})",
                }

            # Guard 4: On-chain position existence check (skip if RPC down here — stale data better than no bet)
            existing_shares = get_ctf_balance(token_id)
            if existing_shares is not None and existing_shares > 0:
                log.critical(
                    f"POSITION EXISTS ON-CHAIN: {existing_shares:.4f} shares of {token_id[:12]}... "
                    f"but no DB record. Blocking duplicate bet."
                )
                return {"success": False, "error": f"On-chain position exists ({existing_shares:.4f} shares) — blocking re-entry"}

            # ── PHASE 1: pre-record as pending (before CLOB call) ──
            clob_attempt_id = str(uuid.uuid4())
            prediction_id = ledger.record_prediction_pending(
                conn,
                market_id=market_id,
                condition_id=market.get("condition_id"),
                question=market["question"],
                slug=market.get("slug"),
                side=side,
                amount_usd=amount_usd,
                odds=odds,
                clob_token_id=token_id,
                end_date=market.get("end_date"),
                cycle_id=context.get("cycle_id"),
                entry_edge=entry_edge,
                entry_confidence=entry_confidence,
                entry_reasoning=entry_reasoning_text or reasoning,
                clob_attempt_id=clob_attempt_id,
            )

            # Snapshot expected shares for post-trade CTF verification
            expected_shares_at_ask = round(amount_usd / best_ask, 6) if best_ask > 0 else 0

            # ── PHASE 2: call CLOB ──
            try:
                fill = buy_shares(token_id, amount_usd, max_price=max_price)
            except Exception as e:
                # Unexpected — not a CLOB-reported failure but a Python-level exception.
                # Mark reconciling so the orphan sweep decides based on on-chain state.
                log.error(f"CLOB call raised unexpectedly: {e}", exc_info=True)
                ledger.record_prediction_reconciling(
                    conn, prediction_id,
                    f"CLOB call raised: {str(e)[:200]}"
                )
                return {"success": False, "error": f"CLOB raised: {e}", "prediction_id": prediction_id, "reconciling": True}

            if not fill.success:
                # CLOB reported a clean failure. Before cancelling, do a quick on-chain check
                # to catch stealth fills the client didn't spot (already done inside buy_shares
                # but a second check catches fills that took longer than the 10s poll window).
                time.sleep(1)
                ctf_shares = get_ctf_balance(token_id)
                if ctf_shares is not None and ctf_shares > 0:
                    log.critical(
                        f"POST-FAIL STEALTH FILL: CLOB said '{fill.error}' but CTF balance shows "
                        f"{ctf_shares:.4f} shares. Flagging for reconciliation."
                    )
                    ledger.record_prediction_reconciling(
                        conn, prediction_id,
                        f"CLOB reported failure but CTF shows {ctf_shares:.4f} shares"
                    )
                    return {"success": False, "error": f"Stealth fill detected — reconciling", "prediction_id": prediction_id, "reconciling": True}

                # If the CLOB client could not verify on-chain state (RPC blind, USDC moved
                # without CTF mint, etc.) do NOT silently cancel — defer to the orphan sweep.
                # This closes the Apr 2026 Pereira hole: cancelling on unverifiable failure
                # erased the trail before the sweep could investigate.
                if fill.error and fill.error.startswith("UNVERIFIED"):
                    log.critical(
                        f"UNVERIFIED CLOB failure: {fill.error}. Flagging for reconciliation "
                        f"rather than cancelling."
                    )
                    ledger.record_prediction_reconciling(
                        conn, prediction_id,
                        f"Unverified failure: {fill.error[:200]}"
                    )
                    return {"success": False, "error": f"Unverified — reconciling: {fill.error}", "prediction_id": prediction_id, "reconciling": True}

                # Genuine failure. Cancel the pending row (no USDC moved, CTF unchanged).
                ledger.record_prediction_cancel(conn, prediction_id, f"CLOB failure: {fill.error}")
                return {"success": False, "error": f"CLOB order failed: {fill.error}", "prediction_id": prediction_id}

            # ── PHASE 3: CLOB reported success. Verify on-chain, then confirm atomically. ──
            # Polymarket v2 has settlement quirks that can produce 1-5%
            # slippage between SDK-predicted and on-chain shares (fees,
            # rounding, partial matching). Plus the chain-state read here
            # races the matchOrders settlement — a single read can return 0
            # while the tx is in mempool. Both motivate a wider tolerance
            # and one short retry before declaring mismatch.
            CTF_VERIFY_TOLERANCE = 0.95  # accept >= 95% of reported shares
            fill_verified = False
            if clob_cfg.get("verify_ctf_on_confirm", True):
                time.sleep(2)  # let the chain settle
                ctf_after = get_ctf_balance(token_id)
                # If the first read suggests mismatch, retry once after a
                # short pause — usually a settlement race, not a real diff.
                if ctf_after is not None and ctf_after < fill.shares * CTF_VERIFY_TOLERANCE:
                    time.sleep(3)
                    retry = get_ctf_balance(token_id)
                    if retry is not None and retry > ctf_after:
                        ctf_after = retry
                if ctf_after is None:
                    # RPC blind — we have a CLOB-reported fill but can't verify on-chain.
                    # Accept the fill (CLOB is authoritative) but log loudly and flag unverified.
                    log.warning(
                        f"CTF verify skipped: RPC unavailable after fill. "
                        f"Trusting CLOB: {fill.shares:.2f} shares, ${fill.amount_usd:.2f}"
                    )
                elif ctf_after < fill.shares * CTF_VERIFY_TOLERANCE:
                    log.critical(
                        f"CTF VERIFY FAILED: CLOB reported {fill.shares:.4f} shares but on-chain "
                        f"CTF balance is {ctf_after:.4f} (existing {existing_shares or 0:.4f}). "
                        f"Flagging reconciling."
                    )
                    ledger.record_prediction_reconciling(
                        conn, prediction_id,
                        f"CTF mismatch: expected {fill.shares:.4f}, on-chain {ctf_after:.4f}"
                    )
                    return {"success": False, "error": "CTF verify failed", "prediction_id": prediction_id, "reconciling": True}
                else:
                    fill_verified = True

            try:
                new_balance = ledger.record_prediction_confirm(
                    conn, prediction_id,
                    fill_amount_usd=fill.amount_usd,
                    fill_shares=fill.shares,
                    fill_odds=fill.avg_price,
                    fill_verified=fill_verified,
                )
            except Exception as e:
                # Ledger write failed AFTER on-chain fill. This is the nightmare case.
                # Do NOT cancel — on-chain position is real. Mark reconciling.
                log.critical(
                    f"LEDGER WRITE FAILED after successful fill: {e}. "
                    f"On-chain has shares; DB write failed. MANUAL RECONCILIATION REQUIRED."
                )
                try:
                    ledger.record_prediction_reconciling(
                        conn, prediction_id,
                        f"Ledger confirm raised: {str(e)[:200]}"
                    )
                except Exception:
                    pass  # best effort; the critical log above is the record
                return {"success": False, "error": f"Ledger write failed: {e}", "prediction_id": prediction_id, "reconciling": True}

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
                "fill_verified": fill_verified,
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
