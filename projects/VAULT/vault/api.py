"""FastAPI read-only API — serves dashboard data from vault.db."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from vault.db import init_db
from vault.guardrails import is_alive
from vault.daemon import read_pid
from vault import ledger
from vault.memory import get_memories
from vault.market_data import get_price

log = logging.getLogger("vault.api")


def _pred_source(p: dict) -> str:
    """Classify a prediction's source: momentum or legacy (intel bets folded into legacy)."""
    reason = (p.get("entry_reasoning") or "").lower()
    if "sharp move" in reason or "momentum" in reason:
        return "momentum"
    return "legacy"


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("VAULT API starting")
    yield
    log.info("VAULT API stopping")


app = FastAPI(title="VAULT API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _conn():
    """Get a DB connection (creates tables if missing)."""
    return init_db()


def _mark_to_market(conn, open_positions: list[dict]) -> list[dict]:
    """Add live price, market_value, and unrealized_pnl to open positions."""
    result = []
    for p in open_positions:
        p = dict(p)
        price_data = get_price(conn, p["asset"])
        if price_data:
            p["current_price"] = price_data["price"]
            p["market_value"] = round(p["quantity"] * price_data["price"], 6)
            p["unrealized_pnl"] = round(p["market_value"] - p["cost_basis"], 6)
        else:
            p["current_price"] = None
            p["market_value"] = p["cost_basis"]
            p["unrealized_pnl"] = 0.0
        result.append(p)
    return result


# ── Status ──────────────────────────────────────────────────────────

@app.get("/api/v1/status")
def get_status():
    conn = _conn()
    try:
        balance = ledger.get_balance(conn)
        burn_rate = ledger.get_burn_rate(conn)
        runway = ledger.get_runway(conn)
        total_api = ledger.get_total_api_costs(conn)
        total_pnl = ledger.get_total_pnl(conn)
        verified_deposits = ledger.get_verified_deposits(conn)
        alive = is_alive(conn)
        pid = read_pid()
        cycle_count = conn.execute("SELECT COUNT(*) as c FROM cycles").fetchone()["c"]

        # Alive duration
        from datetime import datetime, timezone
        first_event = conn.execute(
            "SELECT ts FROM events WHERE event IN ('start', 'resurrect') ORDER BY ts ASC LIMIT 1"
        ).fetchone()
        alive_days = 0.0
        if first_event:
            started = datetime.fromisoformat(first_event["ts"].replace("Z", "+00:00"))
            alive_days = round((datetime.now(timezone.utc) - started).total_seconds() / 86400, 1)

        # Open positions marked to market
        open_pos = _mark_to_market(conn, ledger.get_open_positions(conn))
        positions_value = sum(p["market_value"] for p in open_pos)

        # Open predictions marked to market
        from vault.polymarket import get_current_odds
        open_preds = ledger.get_open_predictions(conn)
        predictions_value = 0.0
        for p in open_preds:
            odds = get_current_odds(conn, p["market_id"])
            if odds:
                current = odds["yes_price"] if p["side"] == "YES" else odds["no_price"]
                predictions_value += p["shares"] * current
            else:
                predictions_value += p["cost_basis"]
        predictions_value = round(predictions_value, 6)

        total_value = round(balance + positions_value + predictions_value, 6)

        # Drawdown from peak (circuit-breaker visibility)
        from vault.db import get_meta
        peak_str = get_meta(conn, "peak_total_value")
        peak_total_value = float(peak_str) if peak_str else total_value
        drawdown_pct = round((peak_total_value - total_value) / peak_total_value, 4) if peak_total_value > 0 else 0.0

        paused_row = conn.execute("SELECT value FROM meta WHERE key = 'paused'").fetchone()

        # Real-mode reconciliation snapshot (post-15-Mar-2026 safeguards)
        is_live_flag = ledger.is_live(conn)
        expected_onchain = ledger.compute_expected_onchain(conn) if is_live_flag else None
        pending_count = conn.execute(
            "SELECT COUNT(*) FROM predictions WHERE status = 'pending' AND execution_mode = 'real'"
        ).fetchone()[0]
        reconciling_count = conn.execute(
            "SELECT COUNT(*) FROM predictions WHERE status = 'reconciling' AND execution_mode = 'real'"
        ).fetchone()[0]
        rpc_fails_str = get_meta(conn, "rpc_failures_consecutive") or "0"
        try:
            rpc_fails = int(rpc_fails_str)
        except ValueError:
            rpc_fails = 0

        return {
            "alive": alive,
            "daemon_running": pid is not None,
            "daemon_pid": pid,
            "balance": round(balance, 6),
            "positions_value": round(positions_value, 6),
            "predictions_value": predictions_value,
            "total_value": total_value,
            "burn_rate": round(burn_rate, 4) if burn_rate else None,
            "runway_days": runway,
            "alive_days": alive_days,
            "cycle_count": cycle_count,
            "total_api_costs": round(total_api, 4),
            "total_pnl": round(total_pnl, 4),
            "verified_deposits": round(verified_deposits, 4),
            "account_pnl": ledger.get_account_pnl(conn, total_value),
            "peak_total_value": peak_total_value,
            "drawdown_pct": drawdown_pct,
            "paused": paused_row is not None and paused_row["value"] == "true",
            "live": is_live_flag,
            "expected_onchain": expected_onchain,
            "pending_predictions": pending_count,
            "reconciling_predictions": reconciling_count,
            "rpc_failures_consecutive": rpc_fails,
        }
    finally:
        conn.close()


@app.get("/api/v1/wallet-transactions")
def get_wallet_transactions(limit: int = Query(100, ge=1, le=1000)):
    """External cashflow log — deposits and withdrawals detected from on-chain transfers."""
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, tx_hash, block_number, ts, direction, amount_usd, token, counterparty, notes "
            "FROM wallet_transactions ORDER BY ts DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        items = [dict(r) for r in rows]
        deposits = [x for x in items if x["direction"] == "deposit"]
        withdrawals = [x for x in items if x["direction"] == "withdrawal"]
        return {
            "items": items,
            "total_deposits_usd": round(sum(x["amount_usd"] for x in deposits), 6),
            "total_withdrawals_usd": round(sum(x["amount_usd"] for x in withdrawals), 6),
            "net_deposits_usd": round(
                sum(x["amount_usd"] for x in deposits) - sum(x["amount_usd"] for x in withdrawals), 6
            ),
            "count_deposits": len(deposits),
            "count_withdrawals": len(withdrawals),
        }
    finally:
        conn.close()


@app.get("/api/v1/reconciliation")
def get_reconciliation():
    """Live vs ledger reconciliation snapshot. Powers the dashboard safety panel."""
    conn = _conn()
    try:
        is_live_flag = ledger.is_live(conn)
        expected = ledger.compute_expected_onchain(conn) if is_live_flag else 0.0

        # Attempt on-chain read (may be slow; do it here so status stays snappy)
        onchain_usdc = None
        try:
            from vault.clob_client import get_usdc_balance
            onchain_usdc = get_usdc_balance()
        except Exception as e:
            log.warning(f"Reconciliation endpoint: RPC failed ({e})")

        drift = None
        if onchain_usdc is not None and is_live_flag:
            drift = round(onchain_usdc - expected, 6)

        from vault.config_loader import load_config
        cfg = load_config()
        tol = cfg.get("trading", {}).get("clob", {}).get("balance_divergence_tolerance", 0.50)

        pending = conn.execute(
            "SELECT id, question, side, shares, cost_basis, pending_since, clob_attempt_id "
            "FROM predictions WHERE status = 'pending' AND execution_mode = 'real' "
            "ORDER BY pending_since ASC"
        ).fetchall()
        reconciling = conn.execute(
            "SELECT id, question, side, shares, cost_basis, entry_reasoning "
            "FROM predictions WHERE status = 'reconciling' AND execution_mode = 'real' "
            "ORDER BY id ASC"
        ).fetchall()

        status = "ok"
        if not is_live_flag:
            status = "not-live"
        elif onchain_usdc is None:
            status = "rpc-down"
        elif drift is not None and drift < -tol:
            status = "negative-drift"
        elif pending or reconciling:
            status = "pending"
        elif drift is not None and drift > tol:
            status = "positive-drift"

        # Daemon liveness — separate signal from reconciliation status.
        # paused=true means the cycle loop is short-circuiting; daemon_running=false
        # means there's no active vault process at all.
        paused_row = conn.execute("SELECT value FROM meta WHERE key = 'paused'").fetchone()
        is_paused = paused_row is not None and paused_row[0] == "true"
        daemon_running = read_pid() is not None

        return {
            "status": status,
            "is_live": is_live_flag,
            "expected_onchain": round(expected, 6) if is_live_flag else None,
            "actual_onchain": round(onchain_usdc, 6) if onchain_usdc is not None else None,
            "drift": drift,
            "tolerance": tol,
            "pending": [dict(r) for r in pending],
            "reconciling": [dict(r) for r in reconciling],
            "daemon_running": daemon_running,
            "paused": is_paused,
        }
    finally:
        conn.close()


# ── Balance History ─────────────────────────────────────────────────

@app.get("/api/v1/balance/history")
def get_balance_history():
    """Balance lifeline with tiered downsampling.

    Last 24h: every point (~1440 max).  1-7 days ago: hourly.  7+ days: daily.
    Positions value: recorded MTM for new rows, cost_basis reconstruction for old.
    """
    conn = _conn()
    try:
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone.utc)
        ts_24h = (now - timedelta(hours=24)).isoformat()
        ts_7d = (now - timedelta(days=7)).isoformat()

        # Tier 1: 7+ days ago — daily (pick last row per day)
        old_daily = conn.execute(
            "SELECT id, ts, balance, positions_value FROM objectives "
            "WHERE ts < ? AND id IN ("
            "  SELECT MAX(id) FROM objectives WHERE ts < ? GROUP BY DATE(ts)"
            ") ORDER BY id",
            (ts_7d, ts_7d),
        ).fetchall()

        # Tier 2: 1-7 days ago — hourly (pick last row per hour)
        mid_hourly = conn.execute(
            "SELECT id, ts, balance, positions_value FROM objectives "
            "WHERE ts >= ? AND ts < ? AND id IN ("
            "  SELECT MAX(id) FROM objectives WHERE ts >= ? AND ts < ? "
            "  GROUP BY STRFTIME('%Y-%m-%d %H', ts)"
            ") ORDER BY id",
            (ts_7d, ts_24h, ts_7d, ts_24h),
        ).fetchall()

        # Tier 3: last 24h — every point
        recent = conn.execute(
            "SELECT id, ts, balance, positions_value FROM objectives "
            "WHERE ts >= ? ORDER BY id",
            (ts_24h,),
        ).fetchall()

        all_rows = list(old_daily) + list(mid_hourly) + list(recent)

        # Find first row with real MTM data
        first_mtm_id = None
        for r in all_rows:
            if r["positions_value"] and r["positions_value"] > 0:
                first_mtm_id = r["id"]
                break

        # For old rows without MTM, reconstruct from prediction timestamps
        preds = None
        if first_mtm_id is None or (all_rows and all_rows[0]["id"] < first_mtm_id):
            preds = conn.execute(
                "SELECT id, cost_basis, opened_at, closed_at FROM predictions ORDER BY id"
            ).fetchall()

        result = []
        for r in all_rows:
            if first_mtm_id and r["id"] >= first_mtm_id:
                pv = r["positions_value"] or 0
            elif preds is not None:
                ts = r["ts"]
                pv = sum(
                    p["cost_basis"] for p in preds
                    if p["opened_at"] and p["opened_at"] <= ts
                    and (not p["closed_at"] or p["closed_at"] > ts)
                )
            else:
                pv = 0.0

            result.append({
                "ts": r["ts"],
                "balance": round(r["balance"] + pv, 6),
                "cash": r["balance"],
                "positions_value": round(pv, 6),
            })
        return result
    finally:
        conn.close()


# ── Cycles ──────────────────────────────────────────────────────────

@app.get("/api/v1/cycles")
def get_cycles(limit: int = Query(50, ge=1, le=500)):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, ts_start, ts_end, action, asset, reasoning, "
            "total_cost, rounds_used, balance_after "
            "FROM cycles WHERE reasoning NOT LIKE 'auto-hold:%' AND reasoning NOT LIKE 'bet blocked:%' "
            "ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Costs ───────────────────────────────────────────────────────────

@app.get("/api/v1/costs")
def get_costs():
    conn = _conn()
    try:
        # By model
        by_model = conn.execute(
            "SELECT model, COUNT(*) as calls, SUM(cost_usd) as total, "
            "SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens "
            "FROM api_calls GROUP BY model ORDER BY total DESC"
        ).fetchall()

        # By day
        by_day = conn.execute(
            "SELECT date(ts) as day, COUNT(*) as calls, SUM(cost_usd) as total "
            "FROM api_calls GROUP BY date(ts) ORDER BY day DESC LIMIT 30"
        ).fetchall()

        return {
            "by_model": [dict(r) for r in by_model],
            "by_day": [dict(r) for r in by_day],
        }
    finally:
        conn.close()


# ── Positions ───────────────────────────────────────────────────────

@app.get("/api/v1/positions")
def get_positions():
    conn = _conn()
    try:
        open_pos = _mark_to_market(conn, ledger.get_open_positions(conn))
        closed_pos = ledger.get_closed_positions(conn)
        return {"open": open_pos, "closed": closed_pos}
    finally:
        conn.close()


# ── Predictions ────────────────────────────────────────────────────

@app.get("/api/v1/predictions")
def get_predictions():
    conn = _conn()
    try:
        from vault.polymarket import get_current_odds

        open_preds = ledger.get_open_predictions(conn)
        # Enrich with current odds + source tag
        for p in open_preds:
            p["source"] = _pred_source(p)
            odds = get_current_odds(conn, p["market_id"])
            if odds:
                current = odds["yes_price"] if p["side"] == "YES" else odds["no_price"]
                p["current_odds"] = current
                p["market_value"] = round(p["shares"] * current, 6)
                p["unrealized_pnl"] = round(p["market_value"] - p["cost_basis"], 6)
            else:
                p["current_odds"] = p["entry_odds"]
                p["market_value"] = p["cost_basis"]
                p["unrealized_pnl"] = 0.0

        closed_preds = ledger.get_closed_predictions(conn)
        for p in closed_preds:
            p["source"] = _pred_source(p)

        # Source-level performance breakdown
        by_source = {}
        for p in open_preds:
            s = p["source"]
            if s not in by_source:
                by_source[s] = {"cost": 0, "value": 0, "unrealized": 0, "realized": 0, "total_cost": 0, "open": 0, "won": 0, "lost": 0}
            by_source[s]["cost"] += p["cost_basis"]
            by_source[s]["total_cost"] += p["cost_basis"]
            by_source[s]["value"] += p["market_value"]
            by_source[s]["unrealized"] += p["unrealized_pnl"]
            by_source[s]["open"] += 1
        for p in closed_preds:
            s = p["source"]
            if s not in by_source:
                by_source[s] = {"cost": 0, "value": 0, "unrealized": 0, "realized": 0, "total_cost": 0, "open": 0, "won": 0, "lost": 0}
            by_source[s]["realized"] += (p.get("pnl") or 0)
            by_source[s]["total_cost"] += (p.get("cost_basis") or 0)
            pnl = p.get("pnl") or 0
            if p.get("resolution") == "won" or (p.get("resolution") == "sold" and pnl > 0):
                by_source[s]["won"] += 1
            elif p.get("resolution") == "lost" or (p.get("resolution") == "sold" and pnl < 0):
                by_source[s]["lost"] += 1
        # Round everything
        for s in by_source:
            for k in ("cost", "value", "unrealized", "realized", "total_cost"):
                by_source[s][k] = round(by_source[s][k], 2)

        return {"open": open_preds, "closed": closed_preds, "by_source": by_source}
    finally:
        conn.close()


# ── Events ──────────────────────────────────────────────────────────

@app.get("/api/v1/events")
def get_events(limit: int = Query(50, ge=1, le=500)):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, ts, event, detail FROM events ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── Memories ────────────────────────────────────────────────────────

@app.get("/api/v1/memories")
def get_memories_endpoint(limit: int = Query(30, ge=1, le=200)):
    conn = _conn()
    try:
        return get_memories(conn, limit=limit)
    finally:
        conn.close()


# ── Pipeline ──────────────────────────────────────────────────────

@app.get("/api/v1/pipeline/latest")
def get_pipeline_latest():
    conn = _conn()
    try:
        from vault.pipeline import get_latest_pipeline_run
        result = get_latest_pipeline_run(conn)
        return result or {"error": "No pipeline runs yet"}
    finally:
        conn.close()


@app.get("/api/v1/pipeline/{cycle_id}")
def get_pipeline_by_cycle(cycle_id: int):
    conn = _conn()
    try:
        from vault.pipeline import get_pipeline_run
        result = get_pipeline_run(conn, cycle_id)
        return result or {"error": f"No pipeline run for cycle {cycle_id}"}
    finally:
        conn.close()


# ── Estimates ─────────────────────────────────────────────────────

@app.get("/api/v1/estimates")
def get_estimates(limit: int = Query(100, ge=1, le=500)):
    conn = _conn()
    try:
        from vault.estimator import get_recent_estimates
        return get_recent_estimates(conn, limit=limit)
    finally:
        conn.close()


# ── Opus Estimates ───────────────────────────────────────────────

@app.get("/api/v1/opus-estimates")
def get_opus_estimates():
    conn = _conn()
    try:
        from vault.intelligence import get_latest_opus_estimates
        return get_latest_opus_estimates(conn)
    finally:
        conn.close()


# ── Sentinel Alerts ──────────────────────────────────────────────

@app.get("/api/v1/sentinel/alerts")
def get_sentinel_alerts(limit: int = Query(50, ge=1, le=200)):
    conn = _conn()
    try:
        from vault.sentinel import get_recent_alerts
        return get_recent_alerts(conn, limit=limit)
    finally:
        conn.close()


# ── Calibration ───────────────────────────────────────────────────

@app.get("/api/v1/calibration")
def get_calibration():
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT market_id, estimated_prob, actual_outcome, resolved_at "
            "FROM calibration ORDER BY id DESC"
        ).fetchall()
        results = [dict(r) for r in rows]

        # Calculate calibration stats if enough data
        if len(results) >= 5:
            # Bucket by probability range
            buckets = {}
            for r in results:
                if r["actual_outcome"] is None:
                    continue
                bucket = round(r["estimated_prob"] * 10) / 10  # 0.0, 0.1, ... 1.0
                if bucket not in buckets:
                    buckets[bucket] = {"estimated": bucket, "count": 0, "actual_yes": 0}
                buckets[bucket]["count"] += 1
                buckets[bucket]["actual_yes"] += r["actual_outcome"]

            calibration_curve = []
            for b in sorted(buckets.values(), key=lambda x: x["estimated"]):
                if b["count"] > 0:
                    b["actual_rate"] = round(b["actual_yes"] / b["count"], 3)
                    calibration_curve.append(b)

            return {"records": results, "calibration_curve": calibration_curve}

        return {"records": results, "calibration_curve": []}
    finally:
        conn.close()


# ── Intelligence ─────────────────────────────────────────────────

@app.get("/api/v1/intelligence/latest")
def get_intelligence_latest():
    conn = _conn()
    try:
        from vault.intelligence import get_latest_intelligence
        result = get_latest_intelligence(conn)
        return result or {"error": "No intelligence document yet — seed with 'vault seed-intel'"}
    finally:
        conn.close()


# ── Digest (legacy) ──────────────────────────────────────────────

@app.get("/api/v1/digest/latest")
def get_digest_latest():
    conn = _conn()
    try:
        from vault.digest import get_latest_digest
        result = get_latest_digest(conn)
        return result or {"error": "No digests generated yet"}
    finally:
        conn.close()


@app.get("/api/v1/digests")
def get_digests(limit: int = Query(10, ge=1, le=50)):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, ts, cycle_id, tweet_count, hours_back, digest_text, model_used, cost_usd "
            "FROM digests ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ── X Feed ────────────────────────────────────────────────────────

@app.get("/api/v1/x-feed")
def get_x_feed(limit: int = Query(50, ge=1, le=200)):
    conn = _conn()
    try:
        from vault.x_feed import get_recent_tweets
        return get_recent_tweets(conn, limit=limit)
    finally:
        conn.close()


# ── Musk Markets ──────────────────────────────────────────────────

@app.get("/api/v1/musk-markets")
def get_musk_markets():
    conn = _conn()
    try:
        from vault.market_discovery import get_tracked_markets, get_odds_history
        markets = get_tracked_markets(conn)
        # Attach recent odds history to each market
        for m in markets:
            m["odds_history"] = get_odds_history(conn, m["market_id"], hours=48)
        return markets
    finally:
        conn.close()


# ── Smart Money ──────────────────────────────────────────────────

@app.get("/api/v1/smart-money/log")
def get_smart_money_log(limit: int = Query(50, ge=1, le=200)):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT * FROM smart_money_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.get("/api/v1/smart-money/summary")
def get_smart_money_summary():
    conn = _conn()
    try:
        # Counts by action
        action_counts = conn.execute(
            "SELECT action_taken, COUNT(*) as count FROM smart_money_log GROUP BY action_taken"
        ).fetchall()
        counts = {r["action_taken"]: r["count"] for r in action_counts}

        # Veto effectiveness
        veto_correct = conn.execute(
            "SELECT COUNT(*) as c, SUM(counterfactual_pnl) as pnl "
            "FROM smart_money_log WHERE outcome = 'veto_correct'"
        ).fetchone()
        veto_wrong = conn.execute(
            "SELECT COUNT(*) as c, SUM(counterfactual_pnl) as pnl "
            "FROM smart_money_log WHERE outcome = 'veto_wrong'"
        ).fetchone()

        # Momentum stats
        momentum_wins = conn.execute(
            "SELECT COUNT(*) as c, SUM(outcome_pnl) as pnl "
            "FROM smart_money_log WHERE action_taken = 'momentum_bet' AND outcome = 'won'"
        ).fetchone()
        momentum_losses = conn.execute(
            "SELECT COUNT(*) as c, SUM(outcome_pnl) as pnl "
            "FROM smart_money_log WHERE action_taken = 'momentum_bet' AND outcome = 'lost'"
        ).fetchone()

        # Boost stats
        boost_wins = conn.execute(
            "SELECT COUNT(*) as c, SUM(outcome_pnl) as pnl "
            "FROM smart_money_log WHERE action_taken = 'boost' AND outcome = 'won'"
        ).fetchone()
        boost_losses = conn.execute(
            "SELECT COUNT(*) as c, SUM(outcome_pnl) as pnl "
            "FROM smart_money_log WHERE action_taken = 'boost' AND outcome = 'lost'"
        ).fetchone()

        total_pending = conn.execute(
            "SELECT COUNT(*) as c FROM smart_money_log WHERE outcome = 'pending'"
        ).fetchone()["c"]

        # Veto saved vs cost (resolved)
        veto_saved = abs(veto_correct["pnl"] or 0)  # losses we avoided
        veto_cost = abs(veto_wrong["pnl"] or 0)  # gains we missed

        # ── Mark-to-market for pending entries ───────────────────────
        from vault.polymarket import get_current_odds

        # Build map of open predictions by market_id for MTM lookups
        open_preds = conn.execute(
            "SELECT id, market_id, side, shares, cost_basis "
            "FROM predictions WHERE status = 'open'"
        ).fetchall()
        # Multiple predictions can exist per market — aggregate per market+side
        pred_by_market = {}
        for p in open_preds:
            p = dict(p)
            key = p["market_id"]
            if key not in pred_by_market:
                pred_by_market[key] = {"shares": 0, "cost_basis": 0, "side": p["side"]}
            pred_by_market[key]["shares"] += p["shares"]
            pred_by_market[key]["cost_basis"] += p["cost_basis"]

        # Get distinct pending markets that need MTM
        pending_markets = conn.execute(
            "SELECT DISTINCT market_id, action_taken, counterfactual_size, "
            "counterfactual_side, market_odds "
            "FROM smart_money_log "
            "WHERE outcome = 'pending' AND action_taken IN ('momentum_bet', 'boost', 'veto')"
        ).fetchall()

        mtm_momentum = 0.0
        mtm_boost = 0.0
        mtm_veto_saved = 0.0
        mtm_veto_cost = 0.0
        # Track which market+action combos we've already MTM'd (avoid double-counting)
        mtm_done = set()

        for row in pending_markets:
            row = dict(row)
            mk = (row["market_id"], row["action_taken"])
            if mk in mtm_done:
                continue
            mtm_done.add(mk)

            odds = get_current_odds(conn, row["market_id"])
            if not odds:
                continue
            current_yes = odds["yes_price"]

            if row["action_taken"] in ("momentum_bet", "boost"):
                pred = pred_by_market.get(row["market_id"])
                if not pred:
                    continue
                current_price = current_yes if pred["side"] == "YES" else (1 - current_yes)
                unrealised = pred["shares"] * current_price - pred["cost_basis"]
                if row["action_taken"] == "momentum_bet":
                    mtm_momentum += unrealised
                else:
                    mtm_boost += unrealised

            elif row["action_taken"] == "veto":
                cf_side = row["counterfactual_side"]
                cf_size = row["counterfactual_size"] or 0
                entry_odds = row["market_odds"]
                if cf_side and cf_size > 0 and entry_odds:
                    cf_entry_price = entry_odds if cf_side == "YES" else (1 - entry_odds)
                    if cf_entry_price > 0:
                        cf_shares = cf_size / cf_entry_price
                        cf_current = current_yes if cf_side == "YES" else (1 - current_yes)
                        cf_unrealised = cf_shares * cf_current - cf_size
                        if cf_unrealised < 0:
                            mtm_veto_saved += abs(cf_unrealised)
                        else:
                            mtm_veto_cost += cf_unrealised

        # Combine resolved + unrealised
        total_veto_saved = veto_saved + mtm_veto_saved
        total_veto_cost = veto_cost + mtm_veto_cost
        total_momentum = (momentum_wins["pnl"] or 0) + (momentum_losses["pnl"] or 0) + mtm_momentum
        total_boost = (boost_wins["pnl"] or 0) + (boost_losses["pnl"] or 0) + mtm_boost

        return {
            "counts": counts,
            "total_events": sum(counts.values()) if counts else 0,
            "pending": total_pending,
            "veto": {
                "total": counts.get("veto", 0),
                "correct": veto_correct["c"],
                "wrong": veto_wrong["c"],
                "saved_usd": round(total_veto_saved, 2),
                "cost_usd": round(total_veto_cost, 2),
                "net_usd": round(total_veto_saved - total_veto_cost, 2),
            },
            "boost": {
                "total": counts.get("boost", 0),
                "wins": boost_wins["c"],
                "losses": boost_losses["c"],
                "pnl": round(total_boost, 2),
            },
            "momentum": {
                "total_bets": counts.get("momentum_bet", 0),
                "total_skips": counts.get("momentum_skip", 0),
                "wins": momentum_wins["c"],
                "losses": momentum_losses["c"],
                "pnl": round(total_momentum, 2),
            },
        }
    finally:
        conn.close()


# ── Backtest ──────────────────────────────────────────────────────

@app.get("/api/v1/backtest/latest")
def get_backtest_latest():
    conn = _conn()
    try:
        from vault.backtester import get_latest_results
        results = get_latest_results(conn)
        if not results:
            return {"error": "No backtest results yet — run 'vault backtest'"}
        return {"results": results, "count": len(results)}
    finally:
        conn.close()


# ── Shadow Trades ────────────────────────────────────────────────

@app.get("/api/v1/shadow/summary")
def get_shadow_summary():
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT variant, "
            "COUNT(*) as total, "
            "SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved, "
            "SUM(CASE WHEN resolved = 1 AND shadow_pnl > 0 THEN 1 ELSE 0 END) as wins, "
            "SUM(CASE WHEN resolved = 1 AND shadow_pnl <= 0 THEN 1 ELSE 0 END) as losses, "
            "COALESCE(SUM(shadow_pnl), 0) as total_pnl, "
            "COALESCE(AVG(cost_basis), 0) as avg_size, "
            "COALESCE(AVG(unrealised_roi), 0) as avg_roi_at_entry "
            "FROM shadow_trades GROUP BY variant ORDER BY variant"
        ).fetchall()
        if not rows:
            return {"variants": [], "message": "No shadow trades recorded yet"}
        variants = []
        for r in rows:
            resolved = r["resolved"]
            variants.append({
                "variant": r["variant"],
                "total": r["total"],
                "resolved": resolved,
                "wins": r["wins"],
                "losses": r["losses"],
                "total_pnl": round(r["total_pnl"], 4),
                "win_rate": round(r["wins"] / resolved, 4) if resolved > 0 else None,
                "avg_size": round(r["avg_size"], 2),
                "avg_roi_at_entry": round(r["avg_roi_at_entry"], 4),
            })
        return {"variants": variants}
    finally:
        conn.close()


@app.get("/api/v1/shadow/trades")
def get_shadow_trades(limit: int = 50):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT * FROM shadow_trades ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def run_api(host: str = "0.0.0.0", port: int = 3200):
    """Run the FastAPI server."""
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="info")
