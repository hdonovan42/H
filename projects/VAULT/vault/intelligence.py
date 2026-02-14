"""Master intelligence document — Opus-maintained daily analysis."""

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


def update_intelligence(conn, cycle_id: int, cfg: dict | None = None) -> tuple[str, list]:
    """Update the master intelligence document with an Opus call.

    Loads current document + all tweets since last update, sends to Opus,
    stores new row in master_intelligence.

    Returns (document, themes).
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
        return ("", [])

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
        return (current_doc, json.loads(current["themes_json"]) if current["themes_json"] else [])

    # Group tweets by account
    by_account = {}
    for t in tweets:
        author = t.get("author", "unknown")
        # If retweeted, group under the retweeter (curated account)
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

    system = (
        "You are a senior intelligence analyst maintaining a master intelligence document "
        "for a prediction market trading system. This document is updated daily and used to "
        "inform betting decisions on Polymarket.\n\n"
        f"You are tracking these curated Twitter/X accounts:\n{acct_block}\n\n"
        "Your task: Update the existing intelligence document by incorporating new tweets.\n\n"
        "Output a JSON object with two fields:\n"
        '1. "document" — Updated ~500-800 word analysis covering:\n'
        "   - KEY DEVELOPMENTS — What happened? What changed?\n"
        "   - NARRATIVE ARCS — Ongoing stories (regulatory, product, political, competitive)\n"
        "   - SOURCE CREDIBILITY — Who is reporting vs speculating? Contradictions?\n"
        "   - PREDICTION MARKET IMPLICATIONS — Events that could resolve markets, tradeable edge\n\n"
        '2. "themes" — Array of actionable themes:\n'
        '   [{\"theme\": \"...\", \"keywords\": [\"...\"], \"edge_type\": \"event|sentiment\"}]\n\n'
        "Exclude themes about: tweet counts, follower milestones, engagement metrics.\n"
        "Focus on: policy decisions, product launches, regulatory actions, executive moves, "
        "legal outcomes, scientific/engineering milestones.\n\n"
        "Respond ONLY with valid JSON — no markdown, no explanation outside the JSON."
    )

    user_prompt = (
        f"CURRENT INTELLIGENCE DOCUMENT:\n\n{current_doc}\n\n"
        f"NEW TWEETS SINCE LAST UPDATE ({len(tweets)} total):\n\n{tweet_block}"
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
        )
    except Exception as e:
        log.error(f"Intelligence update failed: {e}")
        return (current_doc, json.loads(current["themes_json"]) if current["themes_json"] else [])

    # Parse response
    text = ""
    for block in response.get("content", []):
        if block.get("type") == "text":
            text += block["text"]

    document, themes = _parse_intelligence_response(text)
    cost = response.get("cost", 0)

    if not document:
        log.warning("Empty document from intelligence update — keeping current")
        return (current_doc, json.loads(current["themes_json"]) if current["themes_json"] else [])

    themes_json = json.dumps(themes) if themes else None

    # Store new row
    conn.execute(
        "INSERT INTO master_intelligence (document, themes_json, tweet_count, model_used, cost_usd) "
        "VALUES (?, ?, ?, ?, ?)",
        (document, themes_json, len(tweets), model, cost),
    )
    conn.commit()

    log.info(
        f"Intelligence update: {len(tweets)} tweets → {len(document)} chars, "
        f"{len(themes)} themes (${cost:.4f})"
    )
    return (document, themes)


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


def _parse_intelligence_response(text: str) -> tuple[str, list]:
    """Parse Opus JSON response into (document, themes)."""
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
                return ("", [])
        else:
            log.warning(f"No JSON in intelligence response: {text[:200]}")
            return ("", [])

    document = parsed.get("document", "")
    themes = parsed.get("themes", [])

    # Validate themes
    valid_themes = []
    for t in themes:
        if isinstance(t, dict) and "keywords" in t:
            valid_themes.append({
                "theme": t.get("theme", ""),
                "keywords": t.get("keywords", []),
                "edge_type": t.get("edge_type", "event"),
            })

    return (document, valid_themes)
