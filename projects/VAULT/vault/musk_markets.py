"""Musk ecosystem market discovery — searches Polymarket for relevant markets."""

import logging
from vault.config_loader import load_config
from vault.polymarket import search_markets, get_current_odds

log = logging.getLogger("vault.musk_markets")


def collect_musk_markets(conn, cycle_id: int, cfg: dict | None = None) -> list[dict]:
    """Search Polymarket for Musk-ecosystem markets. Deduplicates across keyword searches.

    Stores/updates markets in musk_markets table and records odds snapshots.
    Returns list of market dicts with current odds.
    """
    if cfg is None:
        cfg = load_config()

    musk_cfg = cfg.get("musk_ecosystem", {})
    keywords = musk_cfg.get("polymarket_keywords", ["Tesla", "SpaceX", "Elon", "Musk"])

    seen_ids = set()
    markets = []

    for keyword in keywords:
        try:
            results = search_markets(conn, keyword, limit=10)
            for m in results:
                mid = m["id"]
                if mid in seen_ids:
                    continue
                seen_ids.add(mid)
                markets.append(m)
        except Exception as e:
            log.warning(f"Failed to search markets for '{keyword}': {e}")

    # Store/update in musk_markets table and record odds snapshots
    for m in markets:
        _upsert_market(conn, m)
        record_odds_snapshot(conn, m["id"], m.get("yes_price", 0.5), m.get("no_price", 0.5), cycle_id)

    if markets:
        conn.commit()

    log.info(f"Musk markets: {len(markets)} found across {len(keywords)} keywords (cycle {cycle_id})")
    return markets


def _upsert_market(conn, market: dict):
    """Insert or update a market in the musk_markets table."""
    conn.execute(
        "INSERT INTO musk_markets (market_id, question, slug, yes_price, no_price, volume, end_date) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(market_id) DO UPDATE SET "
        "yes_price=excluded.yes_price, no_price=excluded.no_price, "
        "volume=excluded.volume, end_date=excluded.end_date, "
        "last_seen=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        (market["id"], market.get("question", ""), market.get("slug"),
         market.get("yes_price", 0.5), market.get("no_price", 0.5),
         market.get("volume", 0), market.get("end_date")),
    )


def record_odds_snapshot(conn, market_id: str, yes_price: float, no_price: float, cycle_id: int | None = None):
    """Record a point-in-time odds snapshot for movement tracking."""
    conn.execute(
        "INSERT INTO odds_snapshots (market_id, yes_price, no_price, cycle_id) VALUES (?, ?, ?, ?)",
        (market_id, yes_price, no_price, cycle_id),
    )


def get_odds_history(conn, market_id: str, hours: int = 24) -> list[dict]:
    """Get odds movement history for a market over the last N hours."""
    rows = conn.execute(
        "SELECT yes_price, no_price, ts FROM odds_snapshots "
        "WHERE market_id = ? AND ts > datetime('now', ? || ' hours') "
        "ORDER BY ts ASC",
        (market_id, f"-{hours}"),
    ).fetchall()
    return [dict(r) for r in rows]


def get_tracked_markets(conn) -> list[dict]:
    """Get all tracked Musk-ecosystem markets with their latest odds."""
    rows = conn.execute(
        "SELECT market_id, question, slug, yes_price, no_price, volume, end_date, first_seen, last_seen "
        "FROM musk_markets ORDER BY last_seen DESC"
    ).fetchall()
    return [dict(r) for r in rows]
