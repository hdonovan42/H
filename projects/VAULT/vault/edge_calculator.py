"""Edge detection + position sizing — pure Python, no Claude calls."""

import logging
from datetime import datetime, timezone, timedelta
from vault.config_loader import load_config
from vault import ledger
from vault.polymarket import get_current_odds
from vault.market_discovery import record_odds_snapshot

log = logging.getLogger("vault.edge_calculator")


def _parse_snapshot_ts(ts_str: str) -> datetime:
    """Parse a snapshot timestamp string to datetime. Cached-friendly helper."""
    return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))


def _market_days(end_date: str | None, default: float = 30.0) -> float:
    """Days until market resolves from its end_date. Fallback to default."""
    if not end_date:
        return default
    try:
        end_dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        days = (end_dt - datetime.now(timezone.utc)).total_seconds() / 86400
        return max(days, 0.04)  # ~1h floor
    except (ValueError, TypeError):
        return default


def _snap_span_minutes(snaps: list[dict]) -> float:
    """Minutes between first and last snapshot. Returns 0 if < 2 snapshots."""
    if len(snaps) < 2:
        return 0
    first = datetime.fromisoformat(snaps[0]["ts"].replace("Z", "+00:00"))
    last = datetime.fromisoformat(snaps[-1]["ts"].replace("Z", "+00:00"))
    return (last - first).total_seconds() / 60


def calculate_velocity(conn, market_id: str, vault_prob: float | None = None,
                       cfg: dict | None = None) -> dict | None:
    """Calculate odds velocity from snapshot history. Pure math on existing data.

    Returns dict with v_1h, v_6h, direction, sharp — or None if insufficient data.
    Single 24h query, partitioned in Python to eliminate redundant DB calls.
    """
    from vault.market_discovery import get_odds_history

    vel_cfg = (cfg or {}).get("velocity", {})
    sharp_1h = vel_cfg.get("sharp_threshold_1h", 0.05)
    sharp_6h = vel_cfg.get("sharp_threshold_6h", 0.10)

    # Single DB query for 24h — partition into 1h/6h windows in Python
    history_24h = get_odds_history(conn, market_id, hours=24)
    if not history_24h:
        return None

    now = datetime.now(timezone.utc)
    cutoff_1h = now - timedelta(hours=1)
    cutoff_6h = now - timedelta(hours=6)

    history_1h = [s for s in history_24h if _parse_snapshot_ts(s["ts"]) >= cutoff_1h]
    history_6h = [s for s in history_24h if _parse_snapshot_ts(s["ts"]) >= cutoff_6h]

    if not history_1h and not history_6h:
        return None

    # Current odds = most recent snapshot
    current_yes = history_24h[-1]["yes_price"]

    # Minimum span: need enough data to distinguish signal from noise.
    min_span_1h = vel_cfg.get("min_span_minutes_1h", 5)    # 5 min floor
    min_span_6h = vel_cfg.get("min_span_minutes_6h", 60)   # 1h of 6h

    v_1h = None
    if len(history_1h) >= 2:
        span = _snap_span_minutes(history_1h)
        if span >= min_span_1h:
            v_1h = round(current_yes - history_1h[0]["yes_price"], 4)

    v_6h = None
    if len(history_6h) >= 2:
        span = _snap_span_minutes(history_6h)
        if span >= min_span_6h:
            v_6h = round(current_yes - history_6h[0]["yes_price"], 4)

    # Z-score: normalize v_1h against 24h volatility baseline (sizing amplifier, not entry gate)
    z_min_snapshots = vel_cfg.get("z_min_snapshots", 30)
    z_1h = None

    if v_1h is not None and len(history_24h) >= z_min_snapshots:
        deltas = [history_24h[i + 1]["yes_price"] - history_24h[i]["yes_price"]
                  for i in range(len(history_24h) - 1)]
        if len(deltas) >= 2:
            from statistics import stdev
            stddev_delta = stdev(deltas)
            snaps_per_hour = len(history_24h) / 24
            stddev_1h = stddev_delta * (snaps_per_hour ** 0.5)
            if stddev_1h > 0.001:  # floor to avoid div-by-zero on flat markets
                z_1h = round(v_1h / stddev_1h, 2)

    # Sharp detection: always raw velocity (entry gate — don't let z-score raise the bar)
    sharp = False
    if v_1h is not None and abs(v_1h) >= sharp_1h:
        sharp = True
    if v_6h is not None and abs(v_6h) >= sharp_6h:
        sharp = True

    # Direction relative to VAULT estimate
    direction = "neutral"
    if vault_prob is not None:
        move = v_1h if v_1h is not None else v_6h
        if move is not None and abs(move) > 0.005:
            gap_before = abs(vault_prob - (current_yes - move))
            gap_after = abs(vault_prob - current_yes)
            if gap_after < gap_before:
                direction = "toward"
            elif gap_after > gap_before:
                direction = "away"

    return {"v_1h": v_1h, "v_6h": v_6h, "z_1h": z_1h, "direction": direction, "sharp": sharp}


def _log_smart_money_event(conn, *, cycle_id, market_id, question=None,
                           vel=None, action_taken, vault_estimate=None,
                           market_odds=None, side=None, amount_usd=None,
                           prediction_id=None, counterfactual_size=None,
                           counterfactual_side=None, confidence=None):
    """Insert a row into smart_money_log. Never breaks the pipeline."""
    try:
        conn.execute(
            "INSERT INTO smart_money_log "
            "(cycle_id, market_id, question, v_1h, v_6h, direction, sharp, "
            "action_taken, vault_estimate, market_odds, side, amount_usd, "
            "prediction_id, counterfactual_size, counterfactual_side, "
            "z_1h, confidence) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cycle_id, market_id, question,
             vel.get("v_1h") if vel else None,
             vel.get("v_6h") if vel else None,
             vel.get("direction") if vel else None,
             1 if vel and vel.get("sharp") else 0,
             action_taken, vault_estimate, market_odds, side, amount_usd,
             prediction_id, counterfactual_size, counterfactual_side,
             vel.get("z_1h") if vel else None, confidence),
        )
        conn.commit()
    except Exception as e:
        log.warning(f"Failed to log smart money event for {market_id}: {e}")


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
    min_confidence = edge_cfg.get("min_confidence", 0.3)
    default_duration_days = edge_cfg.get("market_duration_days", 30)  # fallback when no end_date

    balance = ledger.get_balance(conn)
    min_bet_size = round(balance * 0.01, 2)  # 1% of balance — was hardcoded $0.50
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
                record_odds_snapshot(conn, pred["market_id"],
                                     odds["yes_price"], odds["no_price"], cycle_id)

    # Also get odds for estimated markets not found by discovery
    for est in estimates:
        mid = est["market_id"]
        if mid not in market_odds_map:
            odds = get_current_odds(conn, mid)
            if odds:
                end_row = conn.execute(
                    "SELECT end_date FROM musk_markets WHERE market_id = ?", (mid,)
                ).fetchone()
                market_odds_map[mid] = {
                    "id": mid,
                    "question": est.get("question", ""),
                    "yes_price": odds["yes_price"],
                    "no_price": odds["no_price"],
                    "end_date": end_row["end_date"] if end_row else None,
                }
                record_odds_snapshot(conn, mid,
                                     odds["yes_price"], odds["no_price"], cycle_id)

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
        duration_days = _market_days(market.get("end_date"), default_duration_days)
        risk_free_return = recommended_size * risk_free_rate * duration_days
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
        elif has_edge and recommended_size >= min_bet_size and beats_risk_free:
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
                reasoning = f"Size ${recommended_size:.2f} below minimum ${min_bet_size:.2f}"

        # ── Velocity analysis ──
        vel_cfg = cfg.get("velocity", {})
        vel = calculate_velocity(conn, mid, vault_prob, cfg=cfg)
        adj_confidence = confidence
        vel_reasoning = ""
        veto_enabled = vel_cfg.get("veto_enabled", True)
        boost_amount = vel_cfg.get("boost_amount", 0.15)
        haircut_amount = vel_cfg.get("haircut_amount", 0.15)

        if vel and vel["sharp"]:
            if vel["direction"] == "away":
                adj_confidence = max(0.1, confidence - haircut_amount)
                vel_reasoning = (
                    f" SMART MONEY VETO: {_fmt_velocity(vel)} moving AWAY from estimate "
                    f"(confidence {confidence:.0%} → {adj_confidence:.0%})"
                )

                if veto_enabled:
                    # Store counterfactual before overriding
                    cf_size = recommended_size
                    cf_side = side

                    if open_pred:
                        # Flag open position for exit
                        action = "exit"
                        reasoning = f"Smart money exit signal: {_fmt_velocity(vel)} moving away"
                        _log_smart_money_event(
                            conn, cycle_id=cycle_id, market_id=mid,
                            question=market.get("question", ""),
                            vel=vel, action_taken="veto",
                            vault_estimate=vault_prob, market_odds=market_yes,
                            side=side, prediction_id=open_pred["id"],
                            counterfactual_size=cf_size, counterfactual_side=cf_side,
                            confidence=adj_confidence,
                        )
                    elif cf_size > 0:
                        # Hard block — only log when there's an actual bet to veto
                        action = "hold"
                        reasoning = f"Smart money veto: sharp move away blocks bet"
                        _log_smart_money_event(
                            conn, cycle_id=cycle_id, market_id=mid,
                            question=market.get("question", ""),
                            vel=vel, action_taken="veto",
                            vault_estimate=vault_prob, market_odds=market_yes,
                            side=side,
                            counterfactual_size=cf_size, counterfactual_side=cf_side,
                            confidence=adj_confidence,
                        )

            elif vel["direction"] == "toward":
                adj_confidence = min(1.0, confidence + boost_amount)
                vel_reasoning = (
                    f" SMART MONEY CONFIRMS: {_fmt_velocity(vel)} moving toward estimate "
                    f"(confidence {confidence:.0%} → {adj_confidence:.0%})"
                )
            else:
                vel_reasoning = f" Velocity: {_fmt_velocity(vel)} (sharp, neutral)"

            # Recalculate sizing with adjusted confidence if it changed
            if adj_confidence != confidence and not (veto_enabled and vel["direction"] == "away"):
                adjusted_fraction = kelly_fraction * adj_confidence
                adjusted_fraction = max(0, min(adjusted_fraction, max_kelly))
                recommended_size = round(balance * adjusted_fraction, 2) if has_edge else 0
                expected_profit = recommended_size * abs_edge * adj_confidence
                beats_risk_free = expected_profit > (recommended_size * risk_free_rate * duration_days)

                # Recheck action with adjusted values
                if not open_pred:
                    if has_edge and recommended_size >= min_bet_size and beats_risk_free:
                        action = "bet"
                        reasoning = (
                            f"{abs_edge:.0%} edge ({side}), confidence {adj_confidence:.0%}, "
                            f"Kelly {adjusted_fraction:.1%} → ${recommended_size:.2f}, "
                            f"expected profit ${expected_profit:.2f}"
                        )
                    elif action == "bet":
                        action = "hold"
                        reasoning = f"Velocity adjustment dropped below threshold"

            # Log boost events
            if vel["direction"] == "toward":
                _log_smart_money_event(
                    conn, cycle_id=cycle_id, market_id=mid,
                    question=market.get("question", ""),
                    vel=vel, action_taken="boost",
                    vault_estimate=vault_prob, market_odds=market_yes,
                    side=side, amount_usd=recommended_size,
                    confidence=adj_confidence,
                )

            reasoning += vel_reasoning

        edge_result = {
            "market_id": mid,
            "question": market.get("question", est.get("question", "")),
            "vault_prob": vault_prob,
            "market_odds": market_yes,
            "edge": round(edge, 4),
            "abs_edge": round(abs_edge, 4),
            "side": side,
            "confidence": round(adj_confidence, 4),
            "original_confidence": confidence,
            "kelly_fraction": round(adjusted_fraction, 4),
            "recommended_size_usd": recommended_size,
            "action": action,
            "reasoning": reasoning,
            "is_open_position": open_pred is not None,
            "v_1h": vel["v_1h"] if vel else None,
            "v_6h": vel["v_6h"] if vel else None,
            "z_1h": vel["z_1h"] if vel else None,
            "velocity_direction": vel["direction"] if vel else None,
            "velocity_sharp": vel["sharp"] if vel else False,
        }
        results.append(edge_result)

        # Store in DB
        try:
            conn.execute(
                "INSERT INTO edge_calculations "
                "(cycle_id, market_id, vault_prob, market_odds, edge, side, confidence, "
                "recommended_size_usd, action, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (cycle_id, mid, vault_prob, market_yes, round(edge, 4), side,
                 round(adj_confidence, 4), recommended_size, action, reasoning),
            )
        except Exception as e:
            log.warning(f"Failed to store edge calc for {mid}: {e}")

    if results:
        conn.commit()

    # ── Velocity alerts for unestimated markets ──
    # Scan all tracked markets for sharp moves without an Opus estimate
    estimated_ids = {est["market_id"] for est in estimates}
    from vault.market_discovery import get_tracked_markets
    tracked = get_tracked_markets(conn)

    for m in tracked:
        mid = m["market_id"]
        if mid in estimated_ids:
            continue  # Already covered by estimate loop

        vel = calculate_velocity(conn, mid, cfg=cfg)
        if vel and vel["sharp"]:
            results.append({
                "market_id": mid,
                "question": m.get("question", ""),
                "vault_prob": None,
                "market_odds": m.get("yes_price", 0.5),
                "edge": None,
                "abs_edge": None,
                "side": None,
                "confidence": None,
                "original_confidence": None,
                "kelly_fraction": None,
                "recommended_size_usd": 0,
                "action": "velocity_alert",
                "reasoning": f"Sharp move detected: {_fmt_velocity(vel)} (no estimate — needs Opus analysis)",
                "is_open_position": False,
                "v_1h": vel["v_1h"],
                "v_6h": vel["v_6h"],
                "z_1h": vel["z_1h"],
                "velocity_direction": vel["direction"],
                "velocity_sharp": True,
            })
            log.info(f"Velocity alert: {m.get('question', mid)[:60]} — {_fmt_velocity(vel)}")

    # Sort by opportunity quality: |edge| * confidence (best opportunities first)
    # velocity_alert items have no edge, so sort them last
    results.sort(
        key=lambda r: (r["abs_edge"] or 0) * (r["confidence"] or 0),
        reverse=True,
    )

    bets = [r for r in results if r["action"] == "bet"]
    exits = [r for r in results if r["action"] == "exit"]
    alerts = [r for r in results if r["action"] == "velocity_alert"]
    log.info(
        f"Edge calc: {len(results)} analysed, {len(bets)} bet opportunities, "
        f"{len(exits)} exit signals, {len(alerts)} velocity alerts (cycle {cycle_id})"
    )

    return results


def _fmt_velocity(vel: dict) -> str:
    """Format velocity dict as human-readable string."""
    parts = []
    if vel.get("v_1h") is not None:
        parts.append(f"{vel['v_1h']:+.0%}/1h")
    if vel.get("v_6h") is not None:
        parts.append(f"{vel['v_6h']:+.0%}/6h")
    if vel.get("z_1h") is not None:
        parts.append(f"z={vel['z_1h']:.1f}")
    return ", ".join(parts) if parts else "no data"


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
    c) Remaining EV < risk-free return AND < 1% of cost basis

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

    # Exit condition (c): Remaining EV below risk-free AND below 1% of cost basis
    risk_free_threshold = cost_basis * risk_free_rate * 30
    min_remaining_ev = cost_basis * 0.01
    if remaining_ev < risk_free_threshold and remaining_ev < min_remaining_ev:
        return "exit", (
            f"Remaining EV ${remaining_ev:.2f} < risk-free ${risk_free_threshold:.2f} "
            f"and < 1% of cost basis (${min_remaining_ev:.2f}), P&L: ${unrealized_pnl:+.2f}.{thesis_str}"
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
