"""Independent probability estimation — Claude estimates without seeing market odds."""

import json
import logging
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault import ledger

log = logging.getLogger("vault.estimator")


def estimate_probabilities(conn, cycle_id: int, markets: list[dict],
                           digest: str | None = None,
                           market_tweets: dict[str, list[dict]] | None = None,
                           cfg: dict | None = None) -> list[dict]:
    """Estimate probabilities for markets WITHOUT showing Polymarket odds.

    Claude sees: digest briefing + per-market relevant tweets + questions.
    Claude does NOT see: Polymarket odds (prevents anchoring bias).

    Returns list of estimates: {market_id, vault_probability, confidence, reasoning}
    Also re-estimates open positions for drift detection.
    """
    if cfg is None:
        cfg = load_config()

    if not markets:
        log.info("No markets to estimate")
        return []

    edge_cfg = cfg.get("edge", {})
    model = edge_cfg.get("estimator_model", cfg["agent"]["default_model"])

    # Build estimation prompt — deliberately excludes odds
    prompt = _build_estimator_prompt(markets, digest, market_tweets)

    # Include open positions for re-estimation
    open_preds = ledger.get_open_predictions(conn)
    open_market_ids = {p["market_id"] for p in open_preds}

    # Add open position markets that aren't already in the list
    position_markets = []
    market_ids_in_list = {m["id"] for m in markets}
    for pred in open_preds:
        if pred["market_id"] not in market_ids_in_list:
            position_markets.append({
                "id": pred["market_id"],
                "question": pred["question"],
            })

    if position_markets:
        prompt += "\n\nOPEN POSITIONS (re-estimate these too):\n"
        offset = len(markets) + 1
        for i, m in enumerate(position_markets):
            prompt += f"  {offset + i}. \"{m['question']}\"\n"

    all_market_ids = [m["id"] for m in markets] + [m["id"] for m in position_markets]
    all_questions = [m.get("question", "") for m in markets] + [m.get("question", "") for m in position_markets]

    # Single Claude call for all markets (cost-efficient)
    messages = [{"role": "user", "content": prompt}]

    system = (
        "You are a probability estimator. You estimate the likelihood of events based on "
        "available evidence. You do NOT have access to betting market odds — form your own "
        "independent view. Be calibrated: a 70% estimate should be right about 70% of the time. "
        "Respond ONLY with valid JSON — no markdown, no explanation outside the JSON."
    )

    try:
        response = call_claude(
            conn=conn,
            ledger_mod=ledger,
            model=model,
            system=system,
            messages=messages,
            cycle_id=cycle_id,
            purpose="pipeline_estimation",
        )
    except Exception as e:
        log.error(f"Estimation API call failed: {e}")
        return []

    # Parse response
    text = ""
    for block in response.get("content", []):
        if block.get("type") == "text":
            text += block["text"]

    estimates = _parse_estimates(text, all_market_ids, all_questions, model)

    # Store estimates in DB
    for est in estimates:
        try:
            conn.execute(
                "INSERT INTO estimates (cycle_id, market_id, vault_probability, confidence, reasoning, model_used) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (cycle_id, est["market_id"], est["vault_probability"],
                 est["confidence"], est.get("reasoning", ""), model),
            )
        except Exception as e:
            log.warning(f"Failed to store estimate for {est['market_id']}: {e}")

    if estimates:
        conn.commit()

    log.info(f"Estimator: {len(estimates)} estimates from {len(all_market_ids)} markets (cycle {cycle_id})")
    return estimates


def _build_estimator_prompt(markets: list[dict], digest: str | None = None,
                            market_tweets: dict[str, list[dict]] | None = None) -> str:
    """Build the estimation prompt — deliberately excludes market odds.

    Uses rolling digest for broad context + per-market relevant tweets for evidence.
    The digest is a single evolving document — it already contains compressed history.
    """
    prompt = "For each market question below, estimate the probability of YES based on the evidence provided.\n"
    prompt += "You do NOT have access to market odds — form your own view.\n\n"

    # Rolling digest — contains both recent detail and compressed history
    if digest:
        prompt += "INTELLIGENCE BRIEFING (rolling summary — recent events in detail, older events compressed):\n"
        prompt += f"  {digest}\n\n"
    else:
        prompt += "INTELLIGENCE BRIEFING: No intelligence available.\n\n"

    # Markets with per-market evidence
    prompt += "MARKETS AND EVIDENCE:\n"
    if market_tweets is None:
        market_tweets = {}

    for i, m in enumerate(markets):
        mid = m.get("id", "")
        question = m.get("question", "Unknown")
        prompt += f"  {i + 1}. \"{question}\"\n"

        relevant = market_tweets.get(mid, [])
        if relevant:
            prompt += "     Relevant tweets:\n"
            for t in relevant:
                author = t.get("author", "unknown")
                text = t.get("text", "")[:200]
                likes = t.get("likes", 0)
                age = _format_age(t.get("collected_at") or t.get("created_at"))
                line = f"       @{author}"
                if age:
                    line += f" ({age})"
                line += f": \"{text}\""
                if likes and likes > 50:
                    line += f" [{likes} likes]"
                prompt += line + "\n"
        else:
            prompt += "     (no relevant tweets found — limited information edge)\n"
        prompt += "\n"

    prompt += (
        "For each market, respond with a JSON array. Each element:\n"
        '{"market_index": 1, "probability": 0.65, "confidence": 0.7, '
        '"reasoning": "Brief 1-2 sentence explanation"}\n'
        "\nRules:\n"
        "- probability: your estimate of YES happening (0.0 to 1.0)\n"
        "- confidence: how sure you are of your estimate (0.0 to 1.0)\n"
        "- reasoning: brief justification based on evidence\n"
        "- Be well-calibrated. Don't default to 50% — commit to a view.\n"
        "- When no relevant tweets exist for a market, your confidence should be LOWER "
        "(you have less informational edge).\n"
        "- STATISTICAL/COUNTING markets (tweet counts, follower milestones, weekly post counts, "
        "engagement metrics) → SET CONFIDENCE TO 0.2-0.3. You have no informational edge on "
        "these — they are essentially random.\n"
        "- EVENT markets (policy decisions, product launches, regulatory actions, legal outcomes) → "
        "confidence should reflect your SPECIFIC evidence for that event.\n"
    )
    return prompt


def _format_age(ts_str: str | None) -> str:
    """Format a timestamp as a human-readable age like '6h ago'."""
    if not ts_str:
        return ""
    try:
        from datetime import datetime, timezone
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - ts
        hours = delta.total_seconds() / 3600
        if hours < 1:
            return f"{int(delta.total_seconds() / 60)}m ago"
        elif hours < 24:
            return f"{int(hours)}h ago"
        else:
            return f"{int(hours / 24)}d ago"
    except Exception:
        return ""


def _parse_estimates(text: str, market_ids: list[str], questions: list[str], model: str) -> list[dict]:
    """Parse Claude's JSON response into estimate dicts."""
    estimates = []

    # Try to extract JSON array from response
    text = text.strip()
    # Handle markdown code blocks
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        text = text.strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON array in text
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                log.warning(f"Failed to parse estimation response: {text[:200]}")
                return []
        else:
            log.warning(f"No JSON array in estimation response: {text[:200]}")
            return []

    if not isinstance(parsed, list):
        parsed = [parsed]

    for item in parsed:
        idx = item.get("market_index", 0) - 1  # 1-indexed to 0-indexed
        if 0 <= idx < len(market_ids):
            prob = float(item.get("probability", 0.5))
            conf = float(item.get("confidence", 0.5))
            # Clamp values
            prob = max(0.01, min(0.99, prob))
            conf = max(0.1, min(1.0, conf))
            estimates.append({
                "market_id": market_ids[idx],
                "question": questions[idx] if idx < len(questions) else "",
                "vault_probability": prob,
                "confidence": conf,
                "reasoning": item.get("reasoning", ""),
                "model_used": model,
            })

    return estimates


def get_recent_estimates(conn, limit: int = 100) -> list[dict]:
    """Get recent probability estimates from the database."""
    rows = conn.execute(
        "SELECT e.cycle_id, e.market_id, e.vault_probability, e.confidence, "
        "e.reasoning, e.model_used, e.ts, m.question "
        "FROM estimates e LEFT JOIN musk_markets m ON e.market_id = m.market_id "
        "ORDER BY e.id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]
