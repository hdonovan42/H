"""Musk ecosystem market discovery — fetches Polymarket in bulk, filters locally."""

import logging
import re
import httpx
from vault.config_loader import load_config
from vault.polymarket import _parse_market, _save_cache

log = logging.getLogger("vault.musk_markets")

GAMMA_BASE = "https://gamma-api.polymarket.com"


def collect_musk_markets(conn, cycle_id: int, cfg: dict | None = None) -> list[dict]:
    """Fetch active Polymarket markets in bulk and filter locally for Musk ecosystem.

    The Gamma API slug_keyword param is broken (returns unrelated markets),
    so we fetch a large batch sorted by volume and filter by question text.
    Stores/updates in musk_markets table and records odds snapshots.
    """
    if cfg is None:
        cfg = load_config()

    musk_cfg = cfg.get("musk_ecosystem", {})
    raw_keywords = musk_cfg.get(
        "polymarket_keywords", ["Tesla", "SpaceX", "Elon", "Musk"]
    )
    # Build word-boundary regex to avoid partial matches (e.g. "elon" in "Barcelona")
    keyword_pattern = re.compile(
        r'\b(' + '|'.join(re.escape(kw) for kw in raw_keywords) + r')\b',
        re.IGNORECASE,
    )

    # Fetch in bulk — 3 pages of 100, sorted by volume
    all_raw = []
    for offset in [0, 100, 200]:
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

    # Filter locally by keyword match in question text
    markets = []
    seen_ids = set()
    for raw in all_raw:
        parsed = _parse_market(raw)
        if not parsed:
            continue
        mid = parsed["id"]
        if mid in seen_ids:
            continue

        question = parsed.get("question", "")
        if not keyword_pattern.search(question):
            continue

        # Skip extreme odds (resolved in all but name)
        yes = parsed["yes_price"]
        if yes < 0.05 or yes > 0.95:
            continue

        seen_ids.add(mid)
        _save_cache(conn, mid, parsed, yes)
        markets.append(parsed)

    # Store/update in musk_markets table and record odds snapshots
    for m in markets:
        _upsert_market(conn, m)
        record_odds_snapshot(conn, m["id"], m.get("yes_price", 0.5), m.get("no_price", 0.5), cycle_id)

    if markets:
        conn.commit()

    log.info(
        f"Musk markets: {len(markets)} found from {len(all_raw)} scanned "
        f"(keywords: {raw_keywords}, cycle {cycle_id})"
    )
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
