"""Tweet digest — rolling Haiku summary + per-market relevance filtering."""

import logging
from datetime import datetime, timezone
from vault.config_loader import load_config
from vault.claude_client import call_claude
from vault import ledger

log = logging.getLogger("vault.digest")

# Common stopwords to exclude from keyword extraction
STOPWORDS = {
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for",
    "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his",
    "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my",
    "one", "all", "would", "there", "their", "what", "so", "up", "out", "if",
    "about", "who", "get", "which", "go", "me", "when", "make", "can", "like",
    "time", "no", "just", "him", "know", "take", "people", "into", "year",
    "your", "good", "some", "could", "them", "see", "other", "than", "then",
    "now", "look", "only", "come", "its", "over", "think", "also", "back",
    "after", "use", "two", "how", "our", "work", "first", "well", "way", "even",
    "new", "want", "because", "any", "these", "give", "day", "most", "us",
    "are", "was", "were", "been", "has", "had", "did", "does", "is", "am",
    "being", "more", "many", "much", "very", "may", "between",
}


def get_tweets_from_db(conn, hours_back: int = 48) -> list[dict]:
    """Pull all tweets from DB within time window (unlike collect_x_data which returns only new)."""
    rows = conn.execute(
        "SELECT tweet_id, author, text, created_at, likes, retweets, retweeted_by, collected_at "
        "FROM x_posts "
        "WHERE collected_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"
        "ORDER BY id DESC",
        (f"-{hours_back} hours",),
    ).fetchall()
    return [dict(r) for r in rows]


def get_or_generate_digest(conn, cycle_id: int, cfg: dict | None = None) -> str | None:
    """Return cached digest if fresh, otherwise revise the rolling digest with new tweets.

    The digest is a single evolving document. Each revision:
    - Takes the previous digest as context
    - Folds in only NEW tweets since the last update
    - Produces an updated ~200-300 word briefing

    Old context naturally compresses rather than being dropped.
    Returns digest text string or None if no tweets available.
    """
    if cfg is None:
        cfg = load_config()

    digest_cfg = cfg.get("digest", {})
    max_age_hours = digest_cfg.get("max_age_hours", 4)
    model = digest_cfg.get("model", cfg["agent"]["default_model"])

    # Check for fresh cached digest
    cached = conn.execute(
        "SELECT digest_text, ts FROM digests "
        "WHERE ts >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) "
        "ORDER BY id DESC LIMIT 1",
        (f"-{max_age_hours} hours",),
    ).fetchone()

    if cached:
        log.info(f"Using cached digest from {cached['ts']}")
        return cached["digest_text"]

    # Get the previous digest (regardless of age) for revision
    previous = conn.execute(
        "SELECT digest_text, ts FROM digests ORDER BY id DESC LIMIT 1"
    ).fetchone()

    # Get only tweets since the last digest (or all if first run)
    if previous:
        new_tweets = conn.execute(
            "SELECT tweet_id, author, text, created_at, likes, retweets, retweeted_by, collected_at "
            "FROM x_posts WHERE collected_at > ? ORDER BY id DESC",
            (previous["ts"],),
        ).fetchall()
        new_tweets = [dict(r) for r in new_tweets]
    else:
        # First digest ever — use last 48h
        new_tweets = get_tweets_from_db(conn, 48)

    if not new_tweets and not previous:
        log.info("No tweets in DB — skipping digest generation")
        return None

    if not new_tweets and previous:
        # No new tweets but we have an old digest — just return it as-is
        log.info("No new tweets since last digest — reusing previous")
        return previous["digest_text"]

    # Build tweet block for new tweets only
    tweet_lines = []
    for t in new_tweets[:100]:
        author = t.get("author", "unknown")
        text = t.get("text", "")[:280]
        likes = t.get("likes", 0)
        rt_by = t.get("retweeted_by")
        line = f"@{author}: \"{text}\""
        if likes and likes > 50:
            line += f" [{likes} likes]"
        if rt_by:
            line += f" (RT'd by @{rt_by})"
        tweet_lines.append(line)

    if previous:
        # Revision mode — fold new tweets into existing digest
        user_prompt = (
            f"Here is your previous intelligence briefing:\n\n"
            f"---\n{previous['digest_text']}\n---\n\n"
            f"Here are {len(new_tweets)} NEW tweets since that briefing:\n\n"
            + "\n".join(tweet_lines)
        )
        system = (
            "You are an intelligence analyst maintaining a rolling briefing. "
            "Update the previous briefing by incorporating the new tweets. "
            "Add new themes and developments. Update sentiment if it has shifted. "
            "Compress older items that are no longer as relevant — do not drop them entirely, "
            "just give them less space. Keep the total length to ~200-300 words. "
            "Group by themes, not by author. Be concise and factual."
        )
    else:
        # First digest — generate from scratch
        user_prompt = (
            f"Here are {len(new_tweets)} tweets from accounts "
            f"in the Musk/Tesla/SpaceX ecosystem:\n\n"
            + "\n".join(tweet_lines)
        )
        system = (
            "You are an intelligence analyst. Summarize the following tweets into a ~200-300 word "
            "intelligence briefing. Group by themes, not by author. Focus on: key announcements, "
            "sentiment shifts, recurring topics, notable engagement levels. "
            "Be concise and factual. Do not editorialize."
        )

    try:
        response = call_claude(
            conn=conn,
            ledger_mod=ledger,
            model=model,
            system=system,
            messages=[{"role": "user", "content": user_prompt}],
            cycle_id=cycle_id,
            purpose="tweet_digest",
        )
    except Exception as e:
        log.error(f"Digest generation failed: {e}")
        return previous["digest_text"] if previous else None

    # Extract text from response
    digest_text = ""
    for block in response.get("content", []):
        if block.get("type") == "text":
            digest_text += block["text"]

    if not digest_text:
        log.warning("Empty digest response")
        return previous["digest_text"] if previous else None

    cost = response.get("cost", 0)

    # Store revision in DB
    conn.execute(
        "INSERT INTO digests (cycle_id, tweet_count, hours_back, digest_text, model_used, cost_usd) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (cycle_id, len(new_tweets), 0, digest_text, model, cost),
    )
    conn.commit()

    log.info(
        f"Revised digest: {len(new_tweets)} new tweets folded in → "
        f"{len(digest_text)} chars (${cost:.4f})"
    )
    return digest_text


def get_relevant_tweets(conn, market_question: str, hours_back: int = 48, max_tweets: int = 5) -> list[dict]:
    """Pure Python keyword matching — find tweets relevant to a market question.

    Extracts keywords from question (remove stopwords, keep >= 3 chars),
    matches against tweet text, scores by keyword_matches * (1 + likes/1000).
    Returns top N tweets.
    """
    # Extract keywords from question
    words = market_question.lower().replace("?", "").replace("'", "").split()
    keywords = [w for w in words if len(w) >= 3 and w not in STOPWORDS]

    if not keywords:
        return []

    tweets = get_tweets_from_db(conn, hours_back)
    if not tweets:
        return []

    # Score each tweet
    scored = []
    for t in tweets:
        text_lower = (t.get("text") or "").lower()
        matches = sum(1 for kw in keywords if kw in text_lower)
        if matches > 0:
            likes = t.get("likes", 0) or 0
            score = matches * (1 + likes / 1000)
            scored.append((score, t))

    # Sort by score descending, return top N
    scored.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in scored[:max_tweets]]



def get_latest_digest(conn) -> dict | None:
    """Get the most recent digest for the API endpoint."""
    row = conn.execute(
        "SELECT id, ts, cycle_id, tweet_count, hours_back, digest_text, model_used, cost_usd "
        "FROM digests ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return dict(row) if row else None
