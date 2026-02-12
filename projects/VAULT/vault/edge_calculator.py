"""Edge detection + position sizing — pure Python, no Claude calls."""

import logging
from vault.config_loader import load_config
from vault import ledger
from vault.polymarket import get_current_odds

log = logging.getLogger("vault.edge_calculator")


def calculate_edges(conn, cycle_id: int, estimates: list[dict],
                    markets: list[dict], cfg: dict | None = None) -> list[dict]:
    """Calculate edge for each estimated market. Pure math — no Claude call.

    For each market with an estimate:
    - edge = vault_prob - market_odds (positive = bet YES, negative = bet NO)
    - Kelly-like position sizing adjusted by confidence
    - Exit analysis for open positions
    - Opportunity cost ranking

    Returns list of EdgeResult dicts, sorted by |edge| * confidence descending.
    """
    if cfg is None:
        cfg = load_config()

    edge_cfg = cfg.get("edge", {})
    margin_of_safety = edge_cfg.get("margin_of_safety", 0.10)
    max_kelly = edge_cfg.get("max_kelly_fraction", 0.25)
    risk_free_rate = edge_cfg.get("risk_free_daily_rate", 0.0001)
    min_confidence = edge_cfg.get("min_confidence", 0.4)

    balance = ledger.get_balance(conn)
    market_odds_map = {m["id"]: m for m in markets}

    # Also get odds for open positions
    open_preds = ledger.get_open_predictions(conn)
    for pred in open_preds:
        if pred["market_id"] not in market_odds_map:
            odds = get_current_odds(conn, pred["market_id"])
            if odds:
                market_odds_map[pred["market_id"]] = {
                    "id": pred["market_id"],
                    "question": pred["question"],
                    "yes_price": odds["yes_price"],
                    "no_price": odds["no_price"],
                }

    results = []

    for est in estimates:
        mid = est["market_id"]
        vault_prob = est["vault_probability"]
        confidence = est["confidence"]

        market = market_odds_map.get(mid)
        if not market:
            continue

        market_yes = market.get("yes_price", 0.5)
        market_no = market.get("no_price", 0.5)

        # Edge calculation
        edge = vault_prob - market_yes  # positive = YES underpriced, negative = NO underpriced

        abs_edge = abs(edge)
        if edge >= 0:
            side = "YES"
            odds_for_kelly = market_yes
        else:
            side = "NO"
            odds_for_kelly = market_no

        # Check if edge exceeds margin of safety
        has_edge = abs_edge > margin_of_safety and confidence >= min_confidence

        # Kelly-like fraction: edge / odds_against
        # For YES: fraction = (vault_prob - market_yes) / (1 - market_yes)
        # For NO:  fraction = (market_yes - vault_prob) / market_yes  [which is same as (1-vault_prob - market_no) / (1-market_no)]
        if side == "YES" and market_yes < 0.99:
            kelly_fraction = edge / (1 - market_yes)
        elif side == "NO" and market_yes > 0.01:
            kelly_fraction = abs_edge / market_yes
        else:
            kelly_fraction = 0

        # Scale by confidence and cap at max
        adjusted_fraction = kelly_fraction * confidence
        adjusted_fraction = max(0, min(adjusted_fraction, max_kelly))

        recommended_size = round(balance * adjusted_fraction, 2) if has_edge else 0

        # Check if this is an open position
        open_pred = None
        for pred in open_preds:
            if pred["market_id"] == mid:
                open_pred = pred
                break

        # Determine action
        if open_pred:
            action, reasoning = _analyze_open_position(
                open_pred, vault_prob, confidence, market_yes, market_no,
                risk_free_rate, margin_of_safety
            )
        elif has_edge and recommended_size >= 0.50:  # Min bet $0.50
            action = "bet"
            reasoning = (
                f"{abs_edge:.0%} edge ({side}), confidence {confidence:.0%}, "
                f"Kelly {adjusted_fraction:.1%} → ${recommended_size:.2f}"
            )
        else:
            action = "hold"
            if not has_edge:
                reasoning = f"Edge {abs_edge:.0%} < margin {margin_of_safety:.0%}"
            elif confidence < min_confidence:
                reasoning = f"Confidence {confidence:.0%} < minimum {min_confidence:.0%}"
            else:
                reasoning = f"Size ${recommended_size:.2f} below minimum"

        edge_result = {
            "market_id": mid,
            "question": market.get("question", est.get("question", "")),
            "vault_prob": vault_prob,
            "market_odds": market_yes,
            "edge": round(edge, 4),
            "abs_edge": round(abs_edge, 4),
            "side": side,
            "confidence": confidence,
            "kelly_fraction": round(adjusted_fraction, 4),
            "recommended_size_usd": recommended_size,
            "action": action,
            "reasoning": reasoning,
            "is_open_position": open_pred is not None,
        }
        results.append(edge_result)

        # Store in DB
        try:
            conn.execute(
                "INSERT INTO edge_calculations "
                "(cycle_id, market_id, vault_prob, market_odds, edge, side, confidence, "
                "recommended_size_usd, action, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (cycle_id, mid, vault_prob, market_yes, round(edge, 4), side,
                 confidence, recommended_size, action, reasoning),
            )
        except Exception as e:
            log.warning(f"Failed to store edge calc for {mid}: {e}")

    if results:
        conn.commit()

    # Sort by opportunity quality: |edge| * confidence (best opportunities first)
    results.sort(key=lambda r: r["abs_edge"] * r["confidence"], reverse=True)

    bets = [r for r in results if r["action"] == "bet"]
    exits = [r for r in results if r["action"] == "exit"]
    log.info(
        f"Edge calc: {len(results)} analysed, {len(bets)} bet opportunities, "
        f"{len(exits)} exit signals (cycle {cycle_id})"
    )

    return results


def _analyze_open_position(pred: dict, vault_prob: float, confidence: float,
                           market_yes: float, market_no: float,
                           risk_free_rate: float, margin_of_safety: float) -> tuple[str, str]:
    """Analyze whether to hold or exit an open position.

    Returns (action, reasoning) tuple.
    """
    side = pred["side"]
    shares = pred["shares"]
    cost_basis = pred["cost_basis"]
    entry_odds = pred["entry_odds"]

    if side == "YES":
        current_odds = market_yes
        vault_estimate_for_side = vault_prob
    else:
        current_odds = market_no
        vault_estimate_for_side = 1 - vault_prob

    current_value = shares * current_odds
    unrealized_pnl = current_value - cost_basis

    # Remaining expected value: what we expect to gain from here
    expected_payout = shares * vault_estimate_for_side  # expected final value
    remaining_ev = expected_payout - current_value

    # Exit conditions:
    # 1. Edge has evaporated (market moved to match our estimate)
    edge_remaining = abs(vault_estimate_for_side - current_odds)
    if edge_remaining < margin_of_safety * 0.5:  # Edge mostly gone
        return "exit", (
            f"Edge evaporated: VAULT {vault_estimate_for_side:.0%} ≈ market {current_odds:.0%}, "
            f"P&L: ${unrealized_pnl:+.2f}"
        )

    # 2. Remaining upside negligible (< risk-free return)
    if remaining_ev < cost_basis * risk_free_rate * 7:  # Less than a week of risk-free
        return "exit", (
            f"Remaining EV ${remaining_ev:.2f} < risk-free threshold, "
            f"P&L: ${unrealized_pnl:+.2f}"
        )

    # 3. Our estimate flipped against us
    if vault_estimate_for_side < 0.5 and confidence > 0.5:
        return "exit", (
            f"Estimate flipped: VAULT now {vault_estimate_for_side:.0%} for {side}, "
            f"P&L: ${unrealized_pnl:+.2f}"
        )

    # Otherwise hold
    return "hold", (
        f"Holding: VAULT {vault_estimate_for_side:.0%} vs market {current_odds:.0%}, "
        f"remaining EV ${remaining_ev:.2f}, P&L: ${unrealized_pnl:+.2f}"
    )


def get_recent_edges(conn, limit: int = 50) -> list[dict]:
    """Get recent edge calculations."""
    rows = conn.execute(
        "SELECT ec.*, m.question FROM edge_calculations ec "
        "LEFT JOIN musk_markets m ON ec.market_id = m.market_id "
        "ORDER BY ec.id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]
