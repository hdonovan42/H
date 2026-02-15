"""Master intelligence document — Opus-maintained daily analysis + probability estimation."""

import json
import logging
from datetime import datetime, timezone, timedelta
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault import ledger

log = logging.getLogger("vault.intelligence")

# Account descriptions for the Opus analyst
ACCOUNT_DESCRIPTIONS = {
    "elonmusk": "Primary source. CEO of Tesla, SpaceX, xAI. Direct announcements, policy positions.",
    "SawyerMerritt": "Tesla/SpaceX news aggregator. Often first on developments.",
    "farzyness": "Tesla manufacturing/delivery analysis. Technical production knowledge.",
    "TeslaLarry": "Investor perspective. Earnings, valuation, institutional sentiment.",
    "jamesdouma": "SpaceX/Starship technical analysis. Launch readiness, engineering.",
}


def seed_intelligence(conn, document_text: str, themes_json: str | None = None):
    """Insert initial user-provided document into master_intelligence.

    Called once manually via CLI to bootstrap the system.
    """
    conn.execute(
        "INSERT INTO master_intelligence (document, themes_json, tweet_count, model_used) "
        "VALUES (?, ?, 0, 'user-seeded')",
        (document_text, themes_json),
    )
    conn.commit()
    log.info(f"Seeded master intelligence document ({len(document_text)} chars)")


def should_update_intelligence(conn, cfg: dict | None = None) -> bool:
    """Return True if latest master_intelligence.ts is before today's update hour UTC."""
    if cfg is None:
        cfg = load_config()

    intel_cfg = cfg.get("intelligence", {})
    update_hour = intel_cfg.get("update_hour_utc", 0)

    latest = conn.execute(
        "SELECT ts FROM master_intelligence ORDER BY id DESC LIMIT 1"
    ).fetchone()

    if not latest:
        return False  # No document seeded yet — can't update nothing

    now = datetime.now(timezone.utc)
    today_update = now.replace(hour=update_hour, minute=0, second=0, microsecond=0)

    # If we haven't passed today's update hour yet, use yesterday's
    if now < today_update:
        today_update -= timedelta(days=1)

    last_ts = datetime.fromisoformat(latest["ts"].replace("Z", "+00:00"))
    return last_ts < today_update


def update_intelligence(conn, cycle_id: int, cfg: dict | None = None) -> tuple[str, list, list]:
    """Update the master intelligence document + estimate probabilities with a single Opus call.

    Loads current document + all tweets since last update + discoverable markets,
    sends to Opus for combined intelligence analysis + probability estimation.
    Stores new row in master_intelligence and opus_estimates.

    Returns (document, themes, estimates).
    """
    if cfg is None:
        cfg = load_config()

    intel_cfg = cfg.get("intelligence", {})
    model = intel_cfg.get("model", "claude-opus-4-6")

    # Load current document
    current = conn.execute(
        "SELECT id, ts, document, themes_json FROM master_intelligence ORDER BY id DESC LIMIT 1"
    ).fetchone()

    if not current:
        log.warning("No master intelligence document to update — seed one first")
        return ("", [], [])

    current_doc = current["document"]
    last_ts = current["ts"]

    # Load all tweets since last update, grouped by account
    tweets = conn.execute(
        "SELECT tweet_id, author, text, created_at, likes, retweets, retweeted_by, collected_at "
        "FROM x_posts WHERE collected_at > ? ORDER BY collected_at ASC",
        (last_ts,),
    ).fetchall()
    tweets = [dict(r) for r in tweets]

    if not tweets:
        log.info("No new tweets since last intelligence update — keeping current document")
        themes = json.loads(current["themes_json"]) if current["themes_json"] else []
        return (current_doc, themes, [])

    # Group tweets by account
    by_account = {}
    for t in tweets:
        author = t.get("author", "unknown")
        group_key = t.get("retweeted_by") or author
        if group_key not in by_account:
            by_account[group_key] = []
        by_account[group_key].append(t)

    # Format tweets for prompt
    tweet_block = _format_tweets_for_opus(by_account)

    # Build account descriptions block
    acct_lines = []
    for handle, desc in ACCOUNT_DESCRIPTIONS.items():
        count = len(by_account.get(handle, []))
        acct_lines.append(f"- @{handle} ({count} posts) — {desc}")
    acct_block = "\n".join(acct_lines)

    # ── Gather markets to estimate ──────────────────────────────────
    # Discover markets using current themes (before update)
    from vault.market_discovery import discover_markets
    current_themes = json.loads(current["themes_json"]) if current["themes_json"] else []
    markets = discover_markets(conn, cycle_id, current_themes, cfg)

    # Also include open positions not already in discovered markets
    open_preds = ledger.get_open_predictions(conn)
    market_ids_in_list = {m["id"] for m in markets}
    for pred in open_preds:
        if pred["market_id"] not in market_ids_in_list:
            markets.append({
                "id": pred["market_id"],
                "question": pred["question"],
            })
            market_ids_in_list.add(pred["market_id"])

    # Build markets block for prompt (questions only, NO odds — anti-anchoring)
    # Include velocity context where available (momentum info, not actual prices)
    from vault.edge_calculator import calculate_velocity

    markets_block = ""
    if markets:
        markets_block = "\n\nMARKETS TO ESTIMATE:\n"
        markets_block += "For each market, estimate the probability of YES based on your analysis.\n"
        markets_block += "You do NOT have access to market odds — form your own independent view.\n\n"
        for i, m in enumerate(markets):
            vel = calculate_velocity(conn, m["id"])
            vel_note = ""
            if vel:
                parts = []
                if vel.get("v_1h") is not None:
                    parts.append(f"{vel['v_1h']:+.0%}/1h")
                if vel.get("v_6h") is not None:
                    parts.append(f"{vel['v_6h']:+.0%}/6h")
                if parts:
                    vel_note = f" [odds moved {', '.join(parts)}]"
            markets_block += f"  {i + 1}. \"{m.get('question', m['id'])}\"{vel_note}\n"

    # ── Build system prompt ─────────────────────────────────────────
    estimation_rules = ""
    if markets:
        estimation_rules = (
            '\n3. "estimates" — Array of probability estimates for each market:\n'
            '   [{"market_index": 1, "probability": 0.65, "confidence": 0.7, '
            '"reasoning": "Brief 1-2 sentence explanation"}]\n\n'
            "Estimation rules:\n"
            "- probability: your estimate of YES happening (0.0 to 1.0)\n"
            "- confidence: how sure you are of your estimate (0.0 to 1.0)\n"
            "- Be well-calibrated. Don't default to 50% — commit to a view.\n"
            "- STATISTICAL/COUNTING markets (tweet counts, follower milestones, weekly post counts, "
            "engagement metrics) → SET CONFIDENCE TO 0.2-0.3. You have no informational edge on "
            "these — they are essentially random.\n"
            "- EVENT markets (policy decisions, product launches, regulatory actions, legal outcomes) → "
            "confidence should reflect your SPECIFIC evidence for that event.\n"
        )

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    system = (
        "You are a senior intelligence analyst maintaining a master intelligence document "
        "for a prediction market trading system. This document is updated daily and used to "
        "inform betting decisions on Polymarket.\n\n"
        f"CURRENT DATE/TIME: {now_str}\n\n"
        f"You are tracking these curated Twitter/X accounts:\n{acct_block}\n\n"
        "Your task: UPDATE the existing intelligence document by incorporating new tweets. "
        "This is a LIVING DOCUMENT — preserve all existing analysis that remains valid. "
        "Only modify sections where new tweets provide new information. "
        "Do not discard prior analysis just because this update has few tweets. "
        "The document should grow more accurate over time, not get rewritten from scratch"
    )
    if markets:
        system += ", and estimate probabilities for prediction markets"
    system += ".\n\n"

    system += (
        "Output a JSON object with these fields:\n"
        '1. "document" — Updated ~500-800 word analysis covering:\n'
        "   - KEY DEVELOPMENTS — What happened? What changed?\n"
        "   - NARRATIVE ARCS — Ongoing stories (regulatory, product, political, competitive)\n"
        "   - SOURCE CREDIBILITY — Who is reporting vs speculating? Contradictions?\n"
        "   - PREDICTION MARKET IMPLICATIONS — Events that could resolve markets, tradeable edge\n\n"
        '2. "themes" — Array of actionable themes:\n'
        '   [{"theme": "...", "keywords": ["..."], "edge_type": "event|sentiment"}]\n\n'
    )
    system += estimation_rules
    system += (
        "Exclude themes about: tweet counts, follower milestones, engagement metrics.\n"
        "Focus on: policy decisions, product launches, regulatory actions, executive moves, "
        "legal outcomes, scientific/engineering milestones.\n\n"
        "Respond ONLY with valid JSON — no markdown, no explanation outside the JSON."
    )

    user_prompt = (
        f"CURRENT INTELLIGENCE DOCUMENT:\n\n{current_doc}\n\n"
        f"NEW TWEETS SINCE LAST UPDATE ({len(tweets)} total):\n\n{tweet_block}"
        f"{markets_block}"
    )

    try:
        response = call_claude(
            conn=conn,
            ledger_mod=ledger,
            model=model,
            system=system,
            messages=[{"role": "user", "content": user_prompt}],
            cycle_id=cycle_id,
            purpose="intelligence_update",
            max_tokens=4096,
        )
    except Exception as e:
        log.error(f"Intelligence update failed: {e}")
        themes = json.loads(current["themes_json"]) if current["themes_json"] else []
        return (current_doc, themes, [])

    # Parse response
    text = ""
    for block in response.get("content", []):
        if block.get("type") == "text":
            text += block["text"]

    document, themes, raw_estimates = _parse_intelligence_response(text)
    cost = response.get("cost", 0)

    if not document:
        log.warning("Empty document from intelligence update — keeping current")
        themes = json.loads(current["themes_json"]) if current["themes_json"] else []
        return (current_doc, themes, [])

    themes_json = json.dumps(themes) if themes else None

    # Store new intelligence row
    conn.execute(
        "INSERT INTO master_intelligence (document, themes_json, tweet_count, model_used, cost_usd) "
        "VALUES (?, ?, ?, ?, ?)",
        (document, themes_json, len(tweets), model, cost),
    )
    conn.commit()

    # Get the intelligence_id we just inserted
    intel_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    # Parse and store Opus estimates
    estimates = _resolve_estimates(raw_estimates, markets, model)
    if estimates:
        store_opus_estimates(conn, estimates, intel_id)

    log.info(
        f"Intelligence update: {len(tweets)} tweets → {len(document)} chars, "
        f"{len(themes)} themes, {len(estimates)} estimates (${cost:.4f})"
    )
    return (document, themes, estimates)


def get_latest_intelligence(conn) -> dict | None:
    """Return latest row from master_intelligence as dict."""
    row = conn.execute(
        "SELECT id, ts, document, themes_json, tweet_count, model_used, cost_usd "
        "FROM master_intelligence ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return dict(row) if row else None


def _format_tweets_for_opus(by_account: dict[str, list[dict]]) -> str:
    """Format grouped tweets for the Opus prompt."""
    lines = []
    for account, tweets in sorted(by_account.items(), key=lambda x: -len(x[1])):
        lines.append(f"@{account} ({len(tweets)} posts):")
        for t in tweets:
            text = (t.get("text") or "")[:280]
            likes = t.get("likes", 0) or 0
            retweets = t.get("retweets", 0) or 0
            age = _format_age(t.get("collected_at") or t.get("created_at"))
            line = f"  [{age}] \"{text}\""
            if likes > 50 or retweets > 10:
                parts = []
                if likes > 0:
                    parts.append(f"{_compact_number(likes)} likes")
                if retweets > 0:
                    parts.append(f"{_compact_number(retweets)} RT")
                line += f" [{', '.join(parts)}]"
            if t.get("retweeted_by"):
                line += f" (RT'd by @{t['retweeted_by']})"
            lines.append(line)
        lines.append("")
    return "\n".join(lines)


def _format_age(ts_str: str | None) -> str:
    """Format a timestamp as a human-readable age."""
    if not ts_str:
        return "?"
    try:
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
        return "?"


def _compact_number(n: int) -> str:
    """Format number compactly: 1234 → 1.2k."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    elif n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def store_opus_estimates(conn, estimates: list[dict], intelligence_id: int):
    """Write Opus probability estimates to opus_estimates table."""
    for est in estimates:
        try:
            conn.execute(
                "INSERT INTO opus_estimates "
                "(intelligence_id, market_id, question, vault_probability, confidence, reasoning) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (intelligence_id, est["market_id"], est.get("question", ""),
                 est["vault_probability"], est["confidence"], est.get("reasoning", "")),
            )
        except Exception as e:
            log.warning(f"Failed to store opus estimate for {est['market_id']}: {e}")
    if estimates:
        conn.commit()
    log.info(f"Stored {len(estimates)} Opus estimates (intelligence_id={intelligence_id})")


def get_latest_opus_estimates(conn) -> list[dict]:
    """Return the latest Opus estimate per market_id (from the most recent intelligence run)."""
    # Get the latest intelligence_id that has estimates
    latest = conn.execute(
        "SELECT MAX(intelligence_id) as max_id FROM opus_estimates"
    ).fetchone()
    if not latest or not latest["max_id"]:
        return []

    rows = conn.execute(
        "SELECT oe.market_id, oe.question, oe.vault_probability, oe.confidence, "
        "oe.reasoning, oe.intelligence_id, oe.ts, mi.model_used "
        "FROM opus_estimates oe "
        "LEFT JOIN master_intelligence mi ON oe.intelligence_id = mi.id "
        "WHERE oe.intelligence_id = ?",
        (latest["max_id"],),
    ).fetchall()
    return [dict(r) for r in rows]


def _resolve_estimates(raw_estimates: list[dict], markets: list[dict], model: str) -> list[dict]:
    """Map raw estimate dicts (with market_index) to market_ids."""
    estimates = []
    for item in raw_estimates:
        idx = item.get("market_index", 0) - 1  # 1-indexed to 0-indexed
        if 0 <= idx < len(markets):
            prob = float(item.get("probability", 0.5))
            conf = float(item.get("confidence", 0.5))
            prob = max(0.01, min(0.99, prob))
            conf = max(0.1, min(1.0, conf))
            estimates.append({
                "market_id": markets[idx]["id"],
                "question": markets[idx].get("question", ""),
                "vault_probability": prob,
                "confidence": conf,
                "reasoning": item.get("reasoning", ""),
                "model_used": model,
            })
    return estimates


def _parse_intelligence_response(text: str) -> tuple[str, list, list]:
    """Parse Opus JSON response into (document, themes, estimates)."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        text = text.strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in text
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                log.warning(f"Failed to parse intelligence response: {text[:200]}")
                return ("", [], [])
        else:
            log.warning(f"No JSON in intelligence response: {text[:200]}")
            return ("", [], [])

    document = parsed.get("document", "")
    themes = parsed.get("themes", [])
    estimates = parsed.get("estimates", [])

    # Validate themes
    valid_themes = []
    for t in themes:
        if isinstance(t, dict) and "keywords" in t:
            valid_themes.append({
                "theme": t.get("theme", ""),
                "keywords": t.get("keywords", []),
                "edge_type": t.get("edge_type", "event"),
            })

    # Validate estimates (raw — will be resolved by caller)
    valid_estimates = []
    for e in estimates:
        if isinstance(e, dict) and "market_index" in e:
            valid_estimates.append(e)

    return (document, valid_themes, valid_estimates)
