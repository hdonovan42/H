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

        paused_row = conn.execute("SELECT value FROM meta WHERE key = 'paused'").fetchone()

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
            "paused": paused_row is not None and paused_row["value"] == "true",
        }
    finally:
        conn.close()


# ── Balance History ─────────────────────────────────────────────────

@app.get("/api/v1/balance/history")
def get_balance_history(limit: int = Query(500, ge=1, le=5000)):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT ts, balance_after, entry_type, amount, reference_id "
            "FROM ledger ORDER BY id ASC LIMIT ?",
            (limit,),
        ).fetchall()

        # Get live market values for currently-open positions
        open_marked = {p["id"]: p for p in _mark_to_market(conn, ledger.get_open_positions(conn))}

        # Track open positions to compute total value at each point.
        # trade_buy: cash drops, position value goes up
        # trade_sell: cash goes up, position closes
        open_positions = {}  # position_id -> market_value (or cost_basis if closed)
        result = []
        for r in rows:
            entry_type = r["entry_type"]
            ref_id = r["reference_id"]
            if entry_type == "trade_buy" and ref_id is not None:
                # Use live market value if still open, otherwise cost basis
                if ref_id in open_marked:
                    open_positions[ref_id] = open_marked[ref_id]["market_value"]
                else:
                    open_positions[ref_id] = abs(r["amount"])
            elif entry_type == "trade_sell" and ref_id is not None:
                open_positions.pop(ref_id, None)
            elif entry_type == "prediction_buy" and ref_id is not None:
                open_positions[f"pred_{ref_id}"] = abs(r["amount"])
            elif entry_type in ("prediction_resolve", "prediction_sell") and ref_id is not None:
                open_positions.pop(f"pred_{ref_id}", None)

            positions_value = sum(open_positions.values())
            total_value = round(r["balance_after"] + positions_value, 6)
            result.append({
                "ts": r["ts"],
                "balance": total_value,
                "cash": r["balance_after"],
                "positions_value": round(positions_value, 6),
                "type": entry_type,
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
            "FROM cycles ORDER BY id DESC LIMIT ?",
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
        # Enrich with current odds
        for p in open_preds:
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
        return {"open": open_preds, "closed": closed_preds}
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


# ── Digest ────────────────────────────────────────────────────────

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


def run_api(host: str = "0.0.0.0", port: int = 3200):
    """Run the FastAPI server."""
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="info")
