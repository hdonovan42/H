"""X/Twitter data collection via bird CLI — graceful fallback if unavailable."""

import json
import logging
import subprocess
from vault.config_loader import load_config

log = logging.getLogger("vault.x_feed")


def _run_bird(args: list[str], auth_token: str = "", ct0: str = "", timeout: int = 30) -> list[dict]:
    """Run a bird CLI command, return parsed JSON or empty list on failure."""
    try:
        cmd = ["bird"]
        if auth_token:
            cmd += ["--auth-token", auth_token]
        if ct0:
            cmd += ["--ct0", ct0]
        cmd += args
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            log.warning(f"bird command failed: {result.stderr[:200]}")
            return []
        return json.loads(result.stdout) if result.stdout.strip() else []
    except FileNotFoundError:
        log.warning("bird CLI not installed — X feed disabled")
        return []
    except subprocess.TimeoutExpired:
        log.warning("bird CLI timed out")
        return []
    except (json.JSONDecodeError, Exception) as e:
        log.warning(f"bird CLI error: {e}")
        return []


def collect_x_data(conn, cycle_id: int, cfg: dict | None = None) -> list[dict]:
    """Collect tweets from X/Twitter via bird CLI. Returns list of tweet dicts.

    Searches configured keywords and fetches from configured accounts.
    Deduplicates by tweet_id. Stores in x_posts table.
    Returns empty list gracefully if bird is unavailable.
    """
    if cfg is None:
        cfg = load_config()

    musk_cfg = cfg.get("musk_ecosystem", {})
    accounts = musk_cfg.get("x_accounts", ["elonmusk"])
    posts_per_call = musk_cfg.get("x_posts_per_call", 10)
    auth_token = musk_cfg.get("x_auth_token", "")
    ct0 = musk_cfg.get("x_ct0", "")

    all_tweets = {}  # tweet_id -> tweet dict for dedup

    # Fetch from curated accounts only (no keyword search — too much spam)
    for account in accounts:
        handle = account.lstrip("@")
        tweets = _run_bird(["user-tweets", f"@{handle}", "-n", str(posts_per_call), "--json"], auth_token, ct0)
        for t in tweets:
            tid = t.get("id") or t.get("tweet_id") or t.get("id_str")
            if tid and tid not in all_tweets:
                normalized = _normalize_tweet(t, tid)
                # Track who retweeted if the original author differs from the feed account
                if normalized["author"].lower() != handle.lower():
                    normalized["retweeted_by"] = handle
                all_tweets[tid] = normalized

    # Store in DB
    stored = []
    for tid, tweet in all_tweets.items():
        try:
            conn.execute(
                "INSERT OR IGNORE INTO x_posts (tweet_id, author, text, created_at, likes, retweets, retweeted_by, cycle_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (tid, tweet["author"], tweet["text"], tweet.get("created_at"),
                 tweet.get("likes", 0), tweet.get("retweets", 0), tweet.get("retweeted_by"), cycle_id),
            )
            stored.append(tweet)
        except Exception as e:
            log.warning(f"Failed to store tweet {tid}: {e}")

    if stored:
        conn.commit()

    log.info(f"X feed: {len(accounts)} accounts, {len(stored)} tweets stored (cycle {cycle_id})")
    return stored


def _normalize_tweet(raw: dict, tweet_id: str) -> dict:
    """Normalize tweet data from bird CLI output to consistent format."""
    # bird 0.8 uses nested author object with username/name
    author_obj = raw.get("author", {})
    if isinstance(author_obj, dict):
        author = author_obj.get("username") or author_obj.get("screen_name") or "unknown"
    else:
        author = author_obj or raw.get("user", {}).get("screen_name") or raw.get("username", "unknown")

    return {
        "tweet_id": tweet_id,
        "author": author,
        "text": raw.get("full_text") or raw.get("text", ""),
        "created_at": raw.get("createdAt") or raw.get("created_at"),
        "likes": raw.get("likeCount") or raw.get("favorite_count") or raw.get("likes", 0),
        "retweets": raw.get("retweetCount") or raw.get("retweet_count") or raw.get("retweets", 0),
    }


def get_recent_tweets(conn, limit: int = 50) -> list[dict]:
    """Get recent tweets from the database."""
    rows = conn.execute(
        "SELECT tweet_id, author, text, created_at, likes, retweets, retweeted_by, cycle_id, collected_at "
        "FROM x_posts ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]
