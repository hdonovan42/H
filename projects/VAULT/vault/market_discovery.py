"""Theme-based market discovery — replaces hardcoded keyword matching.

Fetches Polymarket markets in bulk, filters by theme-derived keywords
instead of static keyword lists.
"""

import logging
import re
import httpx
from vault.config_loader import load_config
from vault.polymarket import _parse_market, _save_cache

log = logging.getLogger("vault.market_discovery")

GAMMA_BASE = "https://gamma-api.polymarket.com"


def discover_markets(conn, cycle_id: int, themes: list[dict] | None = None,
                     cfg: dict | None = None) -> list[dict]:
    """Fetch active Polymarket markets in bulk and filter by theme keywords.

    Same bulk-fetch mechanism as the old musk_markets module, but filters
    against theme-derived keywords instead of a hardcoded list.
    Falls back to config keywords when no themes are provided.
    Stores/updates in musk_markets table and records odds snapshots.
    """
    if cfg is None:
        cfg = load_config()

    # Build keyword list from themes, or fall back to config keywords
    all_keywords = []
    if themes:
        for theme in themes:
            all_keywords.extend(theme.get("keywords", []))

    # Deduplicate while preserving order
    seen = set()
    keywords = []
    for kw in all_keywords:
        kw_lower = kw.lower()
        if kw_lower not in seen:
            seen.add(kw_lower)
            keywords.append(kw)

    if not keywords:
        # Fallback to config keywords when no themes provided
        musk_cfg = cfg.get("musk_ecosystem", {})
        keywords = musk_cfg.get(
            "polymarket_keywords", ["Tesla", "SpaceX", "Elon", "Musk"]
        )
        log.info(f"No theme keywords — falling back to config keywords: {keywords}")

    # Build word-boundary regex to avoid partial matches
    keyword_pattern = re.compile(
        r'\b(' + '|'.join(re.escape(kw) for kw in keywords) + r')\b',
        re.IGNORECASE,
    )

    # Fetch in bulk — 5 pages of 100, sorted by volume
    all_raw = []
    for offset in [0, 100, 200, 300, 400]:
        try:
            resp = httpx.get(
                f"{GAMMA_BASE}/markets",
                params={
                    "active": "true",
                    "closed": "false",
                    "limit": 100,
                    "offset": offset,
                    "order": "volume",
                    "ascending": "false",
                },
                timeout=10,
            )
            resp.raise_for_status()
            batch = resp.json()
            all_raw.extend(batch)
            if len(batch) < 100:
                break
        except Exception as e:
            log.warning(f"Failed to fetch markets (offset {offset}): {e}")
            break

    # Parse all markets, track everything for velocity, keyword-filter for intel
    intel_markets = []
    tracked_count = 0
    seen_ids = set()
    min_volume = cfg.get("velocity", {}).get("momentum_min_volume", 10000)

    for raw in all_raw:
        parsed = _parse_market(raw)
        if not parsed:
            continue
        mid = parsed["id"]
        if mid in seen_ids:
            continue
        seen_ids.add(mid)

        # Skip extreme odds (resolved in all but name)
        yes = parsed["yes_price"]
        if yes < 0.05 or yes > 0.95:
            continue

        # Keyword match for intel pipeline
        question = parsed.get("question", "")
        is_intel = bool(keyword_pattern.search(question))

        # Track for velocity: keyword matches ALWAYS, others need min volume
        volume = parsed.get("volume", 0) or 0
        if is_intel or volume >= min_volume:
            _upsert_market(conn, parsed)
            record_odds_snapshot(conn, mid, yes,
                                 parsed.get("no_price", 0.5), cycle_id)
            tracked_count += 1

        if is_intel:
            _save_cache(conn, mid, parsed, yes)
            intel_markets.append(parsed)

    if tracked_count:
        conn.commit()

    log.info(
        f"Market discovery: {tracked_count} tracked for velocity, "
        f"{len(intel_markets)} intel-matched from {len(all_raw)} scanned "
        f"({len(keywords)} keywords, cycle {cycle_id})"
    )
    return intel_markets


def _upsert_market(conn, market: dict):
    """Insert or update a market in the musk_markets table."""
    conn.execute(
        "INSERT INTO musk_markets "
        "(market_id, question, slug, yes_price, no_price, volume, end_date, "
        "description, volume_24h, liquidity, spread, competitive, game_start_time, event_title) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(market_id) DO UPDATE SET "
        "yes_price=excluded.yes_price, no_price=excluded.no_price, "
        "volume=excluded.volume, end_date=excluded.end_date, "
        "description=excluded.description, volume_24h=excluded.volume_24h, "
        "liquidity=excluded.liquidity, spread=excluded.spread, "
        "competitive=excluded.competitive, game_start_time=excluded.game_start_time, "
        "event_title=excluded.event_title, "
        "last_seen=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        (market["id"], market.get("question", ""), market.get("slug"),
         market.get("yes_price", 0.5), market.get("no_price", 0.5),
         market.get("volume", 0), market.get("end_date"),
         market.get("description", ""), market.get("volume_24h", 0),
         market.get("liquidity", 0), market.get("spread", 0),
         market.get("competitive", 0), market.get("game_start_time"),
         market.get("event_title", "")),
    )


def record_odds_snapshot(conn, market_id: str, yes_price: float,
                         no_price: float, cycle_id: int | None = None):
    """Record a point-in-time odds snapshot for movement tracking."""
    conn.execute(
        "INSERT INTO odds_snapshots (market_id, yes_price, no_price, cycle_id) VALUES (?, ?, ?, ?)",
        (market_id, yes_price, no_price, cycle_id),
    )


def get_odds_history(conn, market_id: str, hours: int = 24) -> list[dict]:
    """Get odds movement history for a market over the last N hours."""
    rows = conn.execute(
        "SELECT yes_price, no_price, ts FROM odds_snapshots "
        "WHERE market_id = ? AND ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' hours') "
        "ORDER BY ts ASC",
        (market_id, f"-{hours}"),
    ).fetchall()
    return [dict(r) for r in rows]


def get_tracked_markets(conn) -> list[dict]:
    """Get all tracked markets with their latest odds."""
    rows = conn.execute(
        "SELECT market_id, question, slug, yes_price, no_price, volume, end_date, first_seen, last_seen "
        "FROM musk_markets ORDER BY last_seen DESC"
    ).fetchall()
    return [dict(r) for r in rows]
