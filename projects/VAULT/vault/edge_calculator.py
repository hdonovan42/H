"""Edge detection + position sizing — pure Python, no Claude calls."""

import logging
from vault.config_loader import load_config
from vault import ledger
from vault.polymarket import get_current_odds

log = logging.getLogger("vault.edge_calculator")


def calculate_edges(conn, cycle_id: int, estimates: list[dict],
                    markets: list[dict], cfg: dict | None = None,
                    sentinel_results: dict | None = None) -> list[dict]:
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
    market_duration_days = edge_cfg.get("market_duration_days", 30)  # assumed avg market duration

    balance = ledger.get_balance(conn)
    market_odds_map = {m["id"]: m for m in markets}

    # Build sentinel alert lookup by prediction_id
    sentinel_alert_map = {}
    if sentinel_results and sentinel_results.get("position_alerts"):
        for alert in sentinel_results["position_alerts"]:
            sentinel_alert_map[alert["prediction_id"]] = alert

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

        # Expected profit must beat risk-free return on the same capital
        risk_free_return = recommended_size * risk_free_rate * market_duration_days
        expected_profit = recommended_size * abs_edge * confidence
        beats_risk_free = expected_profit > risk_free_return

        # Check if this is an open position
        open_pred = None
        for pred in open_preds:
            if pred["market_id"] == mid:
                open_pred = pred
                break

        # Determine action
        if open_pred:
            sentinel_alert = sentinel_alert_map.get(open_pred["id"])
            action, reasoning = _analyze_open_position(
                open_pred, vault_prob, confidence, market_yes, market_no,
                risk_free_rate, margin_of_safety, sentinel_alert=sentinel_alert
            )
        elif has_edge and recommended_size >= 0.50 and beats_risk_free:
            action = "bet"
            reasoning = (
                f"{abs_edge:.0%} edge ({side}), confidence {confidence:.0%}, "
                f"Kelly {adjusted_fraction:.1%} → ${recommended_size:.2f}, "
                f"expected profit ${expected_profit:.2f}"
            )
        else:
            action = "hold"
            if not has_edge:
                reasoning = f"Edge {abs_edge:.0%} < margin {margin_of_safety:.0%}"
            elif confidence < min_confidence:
                reasoning = f"Confidence {confidence:.0%} < minimum {min_confidence:.0%}"
            elif not beats_risk_free:
                reasoning = (
                    f"Expected profit ${expected_profit:.2f} < risk-free ${risk_free_return:.2f}"
                )
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
                           risk_free_rate: float, margin_of_safety: float,
                           sentinel_alert: dict | None = None) -> tuple[str, str]:
    """Analyze whether to hold or exit an open position.

    Sell discipline: only exit when the THESIS is invalidated, not when the
    market agrees with you (edge narrowing is a win, not an exit signal).

    Exit triggers (in priority order):
    d) Sentinel detected thesis break (breaking news, HIGHEST PRIORITY)
    a) Estimate flipped against position (vault < 45% for your side, confidence >= 50%)
    b) Estimate dropped to < 50% of entry estimate (thesis substantially weakened)
    c) Remaining EV < risk-free return AND < $0.50 absolute

    Returns (action, reasoning) tuple.
    """
    side = pred["side"]
    shares = pred["shares"]
    cost_basis = pred["cost_basis"]
    entry_odds = pred["entry_odds"]
    entry_edge = pred.get("entry_edge")
    entry_reasoning = pred.get("entry_reasoning")

    if side == "YES":
        current_odds = market_yes
        vault_estimate_for_side = vault_prob
    else:
        current_odds = market_no
        vault_estimate_for_side = 1 - vault_prob

    current_value = shares * current_odds
    unrealized_pnl = current_value - cost_basis

    # Remaining expected value: what we expect to gain from here
    expected_payout = shares * vault_estimate_for_side
    remaining_ev = expected_payout - current_value

    # Entry thesis context for logging
    thesis_str = ""
    if entry_edge is not None:
        thesis_str = f" Entry edge: {entry_edge:+.0%}."
    if entry_reasoning:
        thesis_str += f" Entry thesis: {entry_reasoning[:80]}"

    # Exit condition (d): Sentinel detected thesis break — CHECK FIRST
    if sentinel_alert and sentinel_alert.get("status") == "BROKEN":
        return "exit", (
            f"SENTINEL: {sentinel_alert.get('event', 'thesis broken')}. "
            f"P&L: ${unrealized_pnl:+.2f}.{thesis_str}"
        )

    # Exit condition (a): Estimate flipped against position
    if vault_estimate_for_side < 0.45 and confidence >= 0.5:
        return "exit", (
            f"Thesis invalidated: VAULT now {vault_estimate_for_side:.0%} for {side} "
            f"(confidence {confidence:.0%}), P&L: ${unrealized_pnl:+.2f}.{thesis_str}"
        )

    # Exit condition (b): Estimate dropped to < 50% of entry estimate
    # entry_edge is raw edge (vault_prob - market_yes), entry_odds is the price of OUR side at entry
    if entry_edge is not None:
        if side == "YES":
            # entry_odds = market_yes at entry, vault_estimate_for_YES = entry_odds + entry_edge
            entry_estimate = min(0.99, max(0.01, entry_odds + entry_edge))
        else:
            # entry_odds = market_no at entry, entry_edge = vault_prob - (1 - entry_odds)
            # vault_estimate_for_NO = 1 - vault_prob = 1 - (entry_edge + 1 - entry_odds) = entry_odds - entry_edge
            entry_estimate = min(0.99, max(0.01, entry_odds - entry_edge))

        if vault_estimate_for_side < entry_estimate * 0.5:
            return "exit", (
                f"Thesis weakened: VAULT {vault_estimate_for_side:.0%} < 50% of entry estimate "
                f"{entry_estimate:.0%} for {side}, P&L: ${unrealized_pnl:+.2f}.{thesis_str}"
            )

    # Exit condition (c): Remaining EV below risk-free AND below $0.50 absolute
    risk_free_threshold = cost_basis * risk_free_rate * 30
    if remaining_ev < risk_free_threshold and remaining_ev < 0.50:
        return "exit", (
            f"Remaining EV ${remaining_ev:.2f} < risk-free ${risk_free_threshold:.2f} "
            f"and < $0.50, P&L: ${unrealized_pnl:+.2f}.{thesis_str}"
        )

    # Otherwise hold — market converging toward our estimate is a WIN
    return "hold", (
        f"Holding: VAULT {vault_estimate_for_side:.0%} vs market {current_odds:.0%}, "
        f"remaining EV ${remaining_ev:.2f}, P&L: ${unrealized_pnl:+.2f}.{thesis_str}"
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
