"""Safeguard backtester — replay trade history to evaluate parameter configurations.

Read-only analysis module. For each safeguard (cooldown, weather filter, ROI floor,
min volume, max positions), simulates which trades would have been blocked under
different parameter values, then computes statistical significance via Welch's t-test.
"""

import logging
import sqlite3
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from math import sqrt

log = logging.getLogger("vault.backtester")

# Only analyse momentum trades (current system starts at trade #96+)
_MOMENTUM_FILTER = "entry_reasoning LIKE 'Sharp move%'"


@dataclass
class BacktestResult:
    safeguard: str
    param_value: str
    total_trades: int
    trades_blocked: int
    wins_blocked: int
    losses_blocked: int
    pnl_blocked: float        # sum of P&L for blocked trades
    pnl_allowed: float        # sum of P&L for allowed trades
    net_impact: float          # positive = improvement (losses avoided > profits sacrificed)
    p_value: float | None
    cohens_d: float | None
    win_rate_before: float | None
    win_rate_after: float | None
    sample_size: int
    significant: bool          # p < 0.05


def _welch_t_test(group_a: list[float], group_b: list[float]) -> float | None:
    """Welch's t-test for unequal variances. Returns p-value or None if insufficient data."""
    n_a, n_b = len(group_a), len(group_b)
    if n_a < 2 or n_b < 2:
        return None

    mean_a = sum(group_a) / n_a
    mean_b = sum(group_b) / n_b
    var_a = sum((x - mean_a) ** 2 for x in group_a) / (n_a - 1)
    var_b = sum((x - mean_b) ** 2 for x in group_b) / (n_b - 1)

    se = sqrt(var_a / n_a + var_b / n_b) if (var_a / n_a + var_b / n_b) > 0 else 0
    if se == 0:
        return None

    t_stat = (mean_a - mean_b) / se

    # Welch-Satterthwaite degrees of freedom
    num = (var_a / n_a + var_b / n_b) ** 2
    denom = (var_a / n_a) ** 2 / (n_a - 1) + (var_b / n_b) ** 2 / (n_b - 1)
    if denom == 0:
        return None
    df = num / denom

    # Approximate p-value using the t-distribution (two-tailed)
    # Use the incomplete beta function approximation for |t| with df
    return _t_to_p(abs(t_stat), df)


def _t_to_p(t: float, df: float) -> float:
    """Approximate two-tailed p-value from t-statistic and degrees of freedom.

    Uses the regularised incomplete beta function relationship:
    p = I_{df/(df+t^2)}(df/2, 1/2)

    Approximation via continued fraction for the beta CDF.
    """
    if df <= 0:
        return None
    x = df / (df + t * t)
    a, b = df / 2.0, 0.5
    # Regularised incomplete beta via continued fraction (Lentz's method)
    p = _regularised_beta(x, a, b)
    return p


def _regularised_beta(x: float, a: float, b: float, max_iter: int = 200, tol: float = 1e-12) -> float:
    """Regularised incomplete beta function I_x(a, b) via continued fraction."""
    from math import lgamma, exp, log as mlog

    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0

    # Use symmetry relation when x > (a+1)/(a+b+2) for better convergence
    if x > (a + 1) / (a + b + 2):
        return 1.0 - _regularised_beta(1 - x, b, a, max_iter, tol)

    # Log of the beta function normalisation
    ln_prefix = (
        a * mlog(x) + b * mlog(1 - x)
        - mlog(a)
        - (lgamma(a) + lgamma(b) - lgamma(a + b))
    )
    prefix = exp(ln_prefix)

    # Continued fraction (modified Lentz's algorithm)
    f = 1.0
    c = 1.0
    d = 1.0 - (a + b) * x / (a + 1)
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1.0 / d
    f = d

    for m in range(1, max_iter + 1):
        # Even step
        numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
        d = 1.0 + numerator * d
        if abs(d) < 1e-30:
            d = 1e-30
        d = 1.0 / d
        c = 1.0 + numerator / c
        if abs(c) < 1e-30:
            c = 1e-30
        f *= d * c

        # Odd step
        numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
        d = 1.0 + numerator * d
        if abs(d) < 1e-30:
            d = 1e-30
        d = 1.0 / d
        c = 1.0 + numerator / c
        if abs(c) < 1e-30:
            c = 1e-30
        delta = d * c
        f *= delta

        if abs(delta - 1.0) < tol:
            break

    return prefix * f


def _cohens_d(group_a: list[float], group_b: list[float]) -> float | None:
    """Cohen's d effect size (pooled standard deviation)."""
    n_a, n_b = len(group_a), len(group_b)
    if n_a < 2 or n_b < 2:
        return None

    mean_a = sum(group_a) / n_a
    mean_b = sum(group_b) / n_b
    var_a = sum((x - mean_a) ** 2 for x in group_a) / (n_a - 1)
    var_b = sum((x - mean_b) ** 2 for x in group_b) / (n_b - 1)

    pooled_sd = sqrt(((n_a - 1) * var_a + (n_b - 1) * var_b) / (n_a + n_b - 2))
    if pooled_sd == 0:
        return None
    return (mean_a - mean_b) / pooled_sd


def _compute_result(safeguard: str, param_value: str,
                    all_trades: list[dict],
                    blocked_ids: set[int]) -> BacktestResult:
    """Compute backtest metrics for a given set of blocked trade IDs."""
    total = len(all_trades)
    allowed = [t for t in all_trades if t["id"] not in blocked_ids]
    blocked = [t for t in all_trades if t["id"] in blocked_ids]

    wins_blocked = sum(1 for t in blocked if (t["pnl"] or 0) > 0)
    losses_blocked = sum(1 for t in blocked if (t["pnl"] or 0) <= 0)
    pnl_blocked = sum(t["pnl"] or 0 for t in blocked)
    pnl_allowed = sum(t["pnl"] or 0 for t in allowed)

    # Net impact: losing the blocked P&L. If blocked trades were net negative,
    # removing them is positive (we avoided losses).
    net_impact = -pnl_blocked

    # Win rates
    total_wins = sum(1 for t in all_trades if (t["pnl"] or 0) > 0)
    win_rate_before = total_wins / total if total > 0 else None
    allowed_wins = sum(1 for t in allowed if (t["pnl"] or 0) > 0)
    win_rate_after = allowed_wins / len(allowed) if len(allowed) > 0 else None

    # Statistical tests: compare P&L distributions of blocked vs allowed
    blocked_pnl = [t["pnl"] or 0 for t in blocked]
    allowed_pnl = [t["pnl"] or 0 for t in allowed]
    p_value = _welch_t_test(blocked_pnl, allowed_pnl)
    d = _cohens_d(blocked_pnl, allowed_pnl)

    return BacktestResult(
        safeguard=safeguard,
        param_value=str(param_value),
        total_trades=total,
        trades_blocked=len(blocked),
        wins_blocked=wins_blocked,
        losses_blocked=losses_blocked,
        pnl_blocked=round(pnl_blocked, 4),
        pnl_allowed=round(pnl_allowed, 4),
        net_impact=round(net_impact, 4),
        p_value=round(p_value, 6) if p_value is not None else None,
        cohens_d=round(d, 4) if d is not None else None,
        win_rate_before=round(win_rate_before, 4) if win_rate_before is not None else None,
        win_rate_after=round(win_rate_after, 4) if win_rate_after is not None else None,
        sample_size=total,
        significant=p_value is not None and p_value < 0.05,
    )


# ── Weather filter keywords (mirrors agent.py _is_weather_novelty_market) ──

_WEATHER_KEYWORDS = [
    "temperature", "highest temp", "lowest temp", "degrees fahrenheit",
    "degrees celsius", "snowfall", "inches of snow", "rainfall",
    "precipitation", "wind speed", "weather",
]


def _is_weather_market(question: str, event_title: str = "") -> bool:
    combined = (question + " " + event_title).lower()
    return any(kw in combined for kw in _WEATHER_KEYWORDS)


# ── Individual safeguard simulators ─────────────────────────────────────────


def _simulate_add_cooldown(trades: list[dict], cooldown_minutes: int) -> set[int]:
    """Simulate which trades would be blocked by an add-cooldown of N minutes.

    An 'add' is a subsequent trade on the same market+side while a prior position
    is still open. We check the gap between consecutive opens.
    """
    if cooldown_minutes <= 0:
        return set()

    blocked = set()
    # Group by (market_id, side), sorted chronologically
    by_market_side: dict[tuple, list[dict]] = {}
    for t in trades:
        key = (t["market_id"], t["side"])
        by_market_side.setdefault(key, []).append(t)

    for key, group in by_market_side.items():
        group.sort(key=lambda x: x["opened_at"])
        for i in range(1, len(group)):
            prev = group[i - 1]
            curr = group[i]
            # Only applies if previous position was still open when current was opened
            if prev["closed_at"] and prev["closed_at"] <= curr["opened_at"]:
                continue  # previous was already closed — this is a new entry, not an add
            try:
                prev_ts = datetime.fromisoformat(prev["opened_at"].replace("Z", "+00:00"))
                curr_ts = datetime.fromisoformat(curr["opened_at"].replace("Z", "+00:00"))
                gap_minutes = (curr_ts - prev_ts).total_seconds() / 60
                if gap_minutes < cooldown_minutes:
                    blocked.add(curr["id"])
            except (ValueError, TypeError):
                continue

    return blocked


def _simulate_weather_filter(trades: list[dict], conn: sqlite3.Connection, enabled: bool) -> set[int]:
    """Simulate blocking trades on weather/novelty markets."""
    if not enabled:
        return set()

    blocked = set()
    # Cache event_title lookups
    event_cache: dict[str, str] = {}
    for t in trades:
        mid = t["market_id"]
        if mid not in event_cache:
            row = conn.execute(
                "SELECT event_title FROM musk_markets WHERE market_id = ?", (mid,)
            ).fetchone()
            event_cache[mid] = row["event_title"] if row and row["event_title"] else ""

        if _is_weather_market(t["question"], event_cache[mid]):
            blocked.add(t["id"])

    return blocked


def _simulate_add_roi_floor(trades: list[dict], min_roi: float) -> set[int]:
    """Simulate blocking adds where the existing position ROI was below a threshold.

    For adds (subsequent same-market+side trades while prior is open), estimate
    the unrealised ROI at entry time using the entry_odds of the new trade vs
    the cost basis of existing positions.
    """
    if min_roi <= 0:
        return set()

    blocked = set()
    by_market_side: dict[tuple, list[dict]] = {}
    for t in trades:
        key = (t["market_id"], t["side"])
        by_market_side.setdefault(key, []).append(t)

    for key, group in by_market_side.items():
        group.sort(key=lambda x: x["opened_at"])
        for i in range(1, len(group)):
            curr = group[i]
            # Check if any prior position was still open at entry time
            prior_open = [
                g for g in group[:i]
                if not g["closed_at"] or g["closed_at"] > curr["opened_at"]
            ]
            if not prior_open:
                continue  # new entry, not an add

            # Estimate unrealised ROI: current price (from new trade's entry_odds)
            # vs cost basis of prior positions
            total_cost = sum(p["cost_basis"] for p in prior_open)
            total_shares = sum(p["shares"] for p in prior_open)
            if total_cost <= 0 or total_shares <= 0:
                continue

            # The new trade's entry_odds gives us the market price at add time
            current_price = curr["entry_odds"] if curr["side"] == "YES" else (1 - curr["entry_odds"])
            current_value = total_shares * current_price
            roi = (current_value - total_cost) / total_cost

            if roi <= min_roi:
                blocked.add(curr["id"])

    return blocked


def _simulate_min_volume(trades: list[dict], conn: sqlite3.Connection, min_vol: int) -> set[int]:
    """Simulate blocking trades on markets below a volume threshold."""
    blocked = set()
    vol_cache: dict[str, float] = {}
    for t in trades:
        mid = t["market_id"]
        if mid not in vol_cache:
            row = conn.execute(
                "SELECT volume FROM musk_markets WHERE market_id = ?", (mid,)
            ).fetchone()
            vol_cache[mid] = row["volume"] if row and row["volume"] else 0

        if vol_cache[mid] < min_vol:
            blocked.add(t["id"])

    return blocked


def _simulate_max_positions(trades: list[dict], max_pos: int) -> set[int]:
    """Simulate blocking trades when concurrent positions on the same market exceed a cap.

    Walks chronologically and tracks open positions per market.
    """
    blocked = set()

    # Build timeline events: opens and closes
    events = []
    for t in trades:
        events.append(("open", t["opened_at"], t))
        if t["closed_at"]:
            events.append(("close", t["closed_at"], t))
    events.sort(key=lambda e: e[1] or "")

    open_by_market: dict[str, set[int]] = {}

    for event_type, ts, trade in events:
        mid = trade["market_id"]
        if mid not in open_by_market:
            open_by_market[mid] = set()

        if event_type == "close":
            open_by_market[mid].discard(trade["id"])
        elif event_type == "open":
            if len(open_by_market[mid]) >= max_pos:
                blocked.add(trade["id"])
            else:
                open_by_market[mid].add(trade["id"])

    return blocked


# ── Main runner ─────────────────────────────────────────────────────────────


def _load_trades(conn: sqlite3.Connection, lookback_days: int | None = None) -> list[dict]:
    """Load resolved momentum trades for backtesting."""
    where = f"WHERE {_MOMENTUM_FILTER} AND status = 'closed' AND pnl IS NOT NULL"
    if lookback_days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        where += f" AND opened_at >= '{cutoff}'"

    rows = conn.execute(
        f"SELECT id, market_id, question, side, shares, entry_odds, cost_basis, "
        f"opened_at, closed_at, resolution, pnl, status, entry_reasoning "
        f"FROM predictions {where} ORDER BY opened_at"
    ).fetchall()
    return [dict(r) for r in rows]


def run_backtest(conn: sqlite3.Connection, lookback_days: int | None = None,
                 store: bool = True) -> dict[str, list[BacktestResult]]:
    """Run all safeguard scenarios against trade history.

    Args:
        conn: SQLite connection
        lookback_days: Only analyse trades from the last N days (None = all history)
        store: Whether to persist results to backtest_results table

    Returns:
        Dict of {safeguard_name: [BacktestResult, ...]} for each parameter value
    """
    trades = _load_trades(conn, lookback_days)
    if not trades:
        log.warning("No resolved momentum trades found for backtesting")
        return {}

    log.info(f"Backtesting {len(trades)} resolved momentum trades"
             + (f" (last {lookback_days} days)" if lookback_days else ""))

    results: dict[str, list[BacktestResult]] = {}

    # 1. Add cooldown (minutes between adds on same market+side)
    cooldown_values = [0, 5, 10, 15, 20, 30]
    results["add_cooldown"] = []
    for val in cooldown_values:
        blocked = _simulate_add_cooldown(trades, val)
        results["add_cooldown"].append(
            _compute_result("add_cooldown", str(val), trades, blocked)
        )

    # 2. Weather filter (on/off)
    results["weather_filter"] = []
    for enabled in [False, True]:
        blocked = _simulate_weather_filter(trades, conn, enabled)
        results["weather_filter"].append(
            _compute_result("weather_filter", str(enabled).lower(), trades, blocked)
        )

    # 3. Add ROI floor (minimum unrealised ROI to allow adds)
    roi_values = [0.02, 0.04, 0.06, 0.08, 0.10]
    results["add_roi_floor"] = []
    for val in roi_values:
        blocked = _simulate_add_roi_floor(trades, val)
        results["add_roi_floor"].append(
            _compute_result("add_roi_floor", str(val), trades, blocked)
        )

    # 4. Min volume (market volume threshold)
    volume_values = [5000, 10000, 15000]
    results["min_volume"] = []
    for val in volume_values:
        blocked = _simulate_min_volume(trades, conn, val)
        results["min_volume"].append(
            _compute_result("min_volume", str(val), trades, blocked)
        )

    # 5. Max positions per market
    max_pos_values = [3, 4, 5]
    results["max_positions"] = []
    for val in max_pos_values:
        blocked = _simulate_max_positions(trades, val)
        results["max_positions"].append(
            _compute_result("max_positions", str(val), trades, blocked)
        )

    # Store results
    if store:
        _store_results(conn, results, lookback_days)

    return results


def _store_results(conn: sqlite3.Connection, results: dict[str, list[BacktestResult]],
                   lookback_days: int | None):
    """Persist backtest results to the backtest_results table."""
    for safeguard, result_list in results.items():
        for r in result_list:
            conn.execute(
                "INSERT INTO backtest_results "
                "(safeguard, param_value, lookback_days, total_trades, trades_blocked, "
                "wins_blocked, losses_blocked, pnl_impact, p_value, cohens_d, significant) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (r.safeguard, r.param_value, lookback_days, r.total_trades,
                 r.trades_blocked, r.wins_blocked, r.losses_blocked,
                 r.net_impact, r.p_value, r.cohens_d,
                 1 if r.significant else 0),
            )
    conn.commit()
    log.info(f"Stored {sum(len(v) for v in results.values())} backtest results")


def get_latest_results(conn: sqlite3.Connection) -> list[dict]:
    """Get the most recent backtest run results."""
    # Find the latest run_date
    latest = conn.execute(
        "SELECT MAX(run_date) as latest FROM backtest_results"
    ).fetchone()
    if not latest or not latest["latest"]:
        return []

    rows = conn.execute(
        "SELECT * FROM backtest_results WHERE run_date = ? ORDER BY safeguard, param_value",
        (latest["latest"],),
    ).fetchall()
    return [dict(r) for r in rows]


def format_results(results: dict[str, list[BacktestResult]]) -> str:
    """Format backtest results as a readable CLI table."""
    if not results:
        return "No trades found for backtesting."

    lines = []
    total_trades = 0

    for safeguard, result_list in results.items():
        lines.append(f"\n{'─' * 70}")
        lines.append(f"  {safeguard.upper().replace('_', ' ')}")
        lines.append(f"{'─' * 70}")
        lines.append(
            f"  {'Param':>8}  {'Blocked':>7}  {'W/L':>7}  "
            f"{'P&L Impact':>10}  {'p-value':>8}  {'d':>6}  {'Sig':>3}"
        )
        lines.append(f"  {'─' * 62}")

        for r in result_list:
            total_trades = r.total_trades
            p_str = f"{r.p_value:.4f}" if r.p_value is not None else "   n/a"
            d_str = f"{r.cohens_d:+.2f}" if r.cohens_d is not None else "  n/a"
            sig_str = " **" if r.significant else "   "
            impact_str = f"${r.net_impact:+.2f}"
            lines.append(
                f"  {r.param_value:>8}  {r.trades_blocked:>7}  "
                f"{r.wins_blocked}W/{r.losses_blocked}L  "
                f"{impact_str:>10}  {p_str:>8}  {d_str:>6}  {sig_str}"
            )

            if r.win_rate_before is not None and r.win_rate_after is not None:
                wr_delta = r.win_rate_after - r.win_rate_before
                lines.append(
                    f"           Win rate: {r.win_rate_before:.0%} → {r.win_rate_after:.0%} "
                    f"({wr_delta:+.1%})"
                )

    lines.insert(0, f"\nSAFEGUARD BACKTESTER — {total_trades} resolved momentum trades")
    lines.append(f"\n  ** = statistically significant (p < 0.05)")
    lines.append(f"  P&L Impact: positive = improvement (losses avoided > profits lost)")
    lines.append("")
    return "\n".join(lines)
