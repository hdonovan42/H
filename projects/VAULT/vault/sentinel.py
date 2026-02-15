"""Haiku sentinel — thesis integrity monitor + major event detection.

Runs per-cycle, scanning new tweets against open position theses.
Binary output: INTACT or BROKEN. Does NOT estimate probabilities.
Also detects major events that could create tradeable opportunities.
"""

import json
import logging
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault import ledger

log = logging.getLogger("vault.sentinel")


def run_sentinel(conn, cycle_id: int, cfg: dict | None = None) -> dict:
    """Scan recent tweets for thesis breaks + major events.

    Returns {
        "position_alerts": [{prediction_id, market_id, status, event, source}],
        "major_event": {event, source} | None,
        "skipped": bool  (True if no new tweets → no Haiku call made)
    }
    """
    if cfg is None:
        cfg = load_config()

    sentinel_cfg = cfg.get("sentinel", {})
    if not sentinel_cfg.get("enabled", True):
        log.info("Sentinel disabled in config")
        return {"position_alerts": [], "major_event": None, "skipped": True}

    model = sentinel_cfg.get("model", "claude-haiku-4-5-20251001")

    # Load tweets since last cycle (delta only)
    last_cycle_ts = _get_last_cycle_ts(conn, cycle_id)
    tweets = _get_new_tweets(conn, last_cycle_ts)

    if not tweets:
        log.info("Sentinel: no new tweets since last cycle — skipping")
        return {"position_alerts": [], "major_event": None, "skipped": True}

    # Load open predictions
    open_preds = ledger.get_open_predictions(conn)

    # Format tweets block
    tweet_lines = []
    for t in tweets:
        author = t.get("author", "unknown")
        text = (t.get("text") or "")[:280]
        tweet_lines.append(f"@{author}: \"{text}\"")
    tweet_block = "\n".join(tweet_lines)

    # Build position theses block
    positions_block = ""
    if open_preds:
        positions_block = "\nOPEN POSITIONS TO MONITOR:\n"
        for p in open_preds:
            positions_block += f"  [{p['id']}] {p['side']} \"{p['question'][:100]}\"\n"
            if p.get("entry_reasoning"):
                positions_block += f"    Entry thesis: {p['entry_reasoning'][:150]}\n"

    # System prompt — conservative, high burden of proof
    system = (
        "You are a news sentinel for a prediction market trading system.\n\n"
        "You have two jobs:\n\n"
        "JOB 1 — THESIS MONITORING:\n"
        "For each open position, determine if any tweet contains CONCRETE evidence "
        "that contradicts the entry thesis. Only count:\n"
        "- Official announcements from authoritative sources\n"
        "- Regulatory decisions or government actions\n"
        "- Confirmed cancellations, delays, or failures\n"
        "- Verified factual developments that directly contradict the thesis\n\n"
        "Speculation, opinion, and rumor are NOT evidence. "
        "When in doubt: INTACT. False alarms are worse than missed exits.\n\n"
        "JOB 2 — MAJOR EVENT DETECTION:\n"
        "Flag a major_event ONLY if a tweet contains a CONCRETE, VERIFIED event that "
        "would DIRECTLY change a buy/sell/hold decision on one of the open positions above "
        "or on a tracked prediction market listed below. The bar is extremely high:\n"
        "- The event must be CONFIRMED (official announcement, not rumor or speculation)\n"
        "- It must have DIRECT, IMMEDIATE impact on a specific market's outcome probability\n"
        "- It must be significant enough to warrant an emergency re-estimation of probabilities\n"
        "- General news, industry trends, and tangential developments are NOT major events\n"
        "- If a tweet is interesting but wouldn't flip any position or create an obvious new bet, "
        "it is NOT a major event — it can wait for the daily analysis\n\n"
        "Examples that ARE major events: 'Grok 5 officially released', 'Fed announces rate cut', "
        "'SpaceX Starship explodes on launch'\n"
        "Examples that are NOT: 'China releases AI film', 'Jobs data revised', "
        "'Analyst predicts Tesla will...', industry commentary, retweets of general news\n\n"
        "Default to null. When in doubt: null. False triggers waste $0.20 each.\n\n"
        "Output a JSON object:\n"
        '{"positions": [{"prediction_id": 1, "status": "INTACT|BROKEN", '
        '"event": "what happened (if BROKEN)", "source": "@handle"}], '
        '"major_event": {"event": "description", "source": "@handle"} | null}\n\n'
        "If no open positions, output an empty positions array.\n"
        "Respond ONLY with valid JSON — no markdown, no explanation outside the JSON."
    )

    # Build tracked markets block for major_event context
    from vault.market_discovery import get_tracked_markets
    tracked = get_tracked_markets(conn)
    markets_block = ""
    if tracked:
        markets_block = "\nTRACKED PREDICTION MARKETS:\n"
        for m in tracked[:15]:
            markets_block += f"  \"{m['question'][:100]}\"\n"

    user_prompt = f"NEW TWEETS ({len(tweets)}):\n{tweet_block}\n{positions_block}{markets_block}"

    try:
        response = call_claude(
            conn=conn,
            ledger_mod=ledger,
            model=model,
            system=system,
            messages=[{"role": "user", "content": user_prompt}],
            cycle_id=cycle_id,
            purpose="sentinel_check",
        )
    except Exception as e:
        log.error(f"Sentinel call failed: {e}")
        return {"position_alerts": [], "major_event": None, "skipped": False}

    # Parse response
    text = ""
    for block in response.get("content", []):
        if block.get("type") == "text":
            text += block["text"]

    result = _parse_sentinel_response(text, open_preds)

    # Store BROKEN alerts in DB
    for alert in result["position_alerts"]:
        if alert["status"] == "BROKEN":
            try:
                conn.execute(
                    "INSERT INTO sentinel_alerts "
                    "(cycle_id, prediction_id, market_id, status, event, source) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (cycle_id, alert["prediction_id"], alert["market_id"],
                     alert["status"], alert.get("event"), alert.get("source")),
                )
            except Exception as e:
                log.warning(f"Failed to store sentinel alert: {e}")
    conn.commit()

    broken = [a for a in result["position_alerts"] if a["status"] == "BROKEN"]
    log.info(
        f"Sentinel: {len(tweets)} tweets scanned, "
        f"{len(broken)} broken theses, "
        f"major event: {'YES' if result['major_event'] else 'no'} "
        f"(cycle {cycle_id})"
    )

    return result


def get_recent_alerts(conn, limit: int = 50) -> list[dict]:
    """Get recent sentinel alerts (BROKEN only) for API/dashboard."""
    rows = conn.execute(
        "SELECT sa.id, sa.ts, sa.cycle_id, sa.prediction_id, sa.market_id, "
        "sa.status, sa.event, sa.source, p.question "
        "FROM sentinel_alerts sa "
        "LEFT JOIN predictions p ON sa.prediction_id = p.id "
        "ORDER BY sa.id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def _get_last_cycle_ts(conn, current_cycle_id: int) -> str | None:
    """Get the timestamp of the previous cycle's start."""
    row = conn.execute(
        "SELECT ts_start FROM cycles WHERE id < ? ORDER BY id DESC LIMIT 1",
        (current_cycle_id,),
    ).fetchone()
    return row["ts_start"] if row else None


def _get_new_tweets(conn, since_ts: str | None) -> list[dict]:
    """Get tweets collected since the given timestamp."""
    if since_ts:
        rows = conn.execute(
            "SELECT tweet_id, author, text, created_at, likes, retweets, collected_at "
            "FROM x_posts WHERE collected_at > ? ORDER BY collected_at ASC",
            (since_ts,),
        ).fetchall()
    else:
        # No previous cycle — get tweets from last hour
        rows = conn.execute(
            "SELECT tweet_id, author, text, created_at, likes, retweets, collected_at "
            "FROM x_posts WHERE collected_at > datetime('now', '-1 hour') "
            "ORDER BY collected_at ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def _parse_sentinel_response(text: str, open_preds: list[dict]) -> dict:
    """Parse sentinel JSON response."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        text = text.strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                log.warning(f"Failed to parse sentinel response: {text[:200]}")
                return {"position_alerts": [], "major_event": None, "skipped": False}
        else:
            log.warning(f"No JSON in sentinel response: {text[:200]}")
            return {"position_alerts": [], "major_event": None, "skipped": False}

    # Build prediction lookup for market_id resolution
    pred_map = {p["id"]: p for p in open_preds}

    # Validate position alerts
    alerts = []
    for item in parsed.get("positions", []):
        pred_id = item.get("prediction_id")
        status = item.get("status", "INTACT").upper()
        if pred_id and status in ("INTACT", "BROKEN"):
            pred = pred_map.get(pred_id, {})
            alerts.append({
                "prediction_id": pred_id,
                "market_id": pred.get("market_id", ""),
                "status": status,
                "event": item.get("event"),
                "source": item.get("source"),
            })

    # Validate major event
    major_event = parsed.get("major_event")
    if major_event and isinstance(major_event, dict) and major_event.get("event"):
        major_event = {
            "event": major_event["event"],
            "source": major_event.get("source", ""),
        }
    else:
        major_event = None

    return {"position_alerts": alerts, "major_event": major_event, "skipped": False}
