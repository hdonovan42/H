"""Market discovery — bulk-fetch Polymarket markets and track for velocity.

Fetches top markets by volume, filters by minimum volume threshold,
records odds snapshots for momentum/velocity calculations.
"""

import logging
from vault.config_loader import load_config
from vault.polymarket import _parse_market
from vault.http_utils import http_get_with_retry

log = logging.getLogger("vault.market_discovery")

GAMMA_BASE = "https://gamma-api.polymarket.com"


def discover_markets(conn, cycle_id: int, themes: list[dict] | None = None,
                     cfg: dict | None = None) -> list[dict]:
    """Fetch active Polymarket markets in bulk and track those above min volume.

    All markets meeting the volume threshold get odds snapshots recorded
    for velocity/momentum calculations. Returns list of tracked markets.
    """
    if cfg is None:
        cfg = load_config()

    min_volume = cfg.get("velocity", {}).get("momentum_min_volume", 10000)

    # Fetch in bulk — 5 pages of 100, sorted by volume
    all_raw = []
    for offset in [0, 100, 200, 300, 400]:
        try:
            resp = http_get_with_retry(
                f"{GAMMA_BASE}/markets",
                params={
                    "active": "true",
                    "closed": "false",
                    "limit": 100,
                    "offset": offset,
                    "order": "volume",
                    "ascending": "false",
                },
            )
            batch = resp.json()
            all_raw.extend(batch)
            if len(batch) < 100:
                break
        except Exception as e:
            log.warning(f"Failed to fetch markets (offset {offset}): {e}")
            break

    tracked = []
    seen_ids = set()

    for raw in all_raw:
        parsed = _parse_market(raw)
        if not parsed:
            continue
        mid = parsed["id"]
        if mid in seen_ids:
            continue
        seen_ids.add(mid)

        # Skip when gamma didn't return outcomePrices for this market (transient
        # API gap). Without a real price we can't snapshot it or evaluate it,
        # and silently treating it as 50/50 poisons downstream calculations.
        if not parsed.get("has_prices"):
            continue

        # Skip extreme odds (resolved in all but name)
        yes = parsed["yes_price"]
        if yes < 0.05 or yes > 0.95:
            continue

        # Volume gate — same threshold used at entry stage in agent.py
        volume = parsed.get("volume", 0) or 0
        if volume < min_volume:
            continue

        _upsert_market(conn, parsed)
        record_odds_snapshot(conn, mid, yes, parsed["no_price"], cycle_id)
        tracked.append(parsed)

    if tracked:
        conn.commit()

    log.info(
        f"Market discovery: {len(tracked)} tracked for velocity "
        f"(>=${min_volume:,.0f} vol) from {len(all_raw)} scanned (cycle {cycle_id})"
    )
    return tracked


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


def prune_old_snapshots(conn, keep_hours: int = 48):
    """Prune old odds snapshots to control table growth.

    Data < keep_hours old: keep everything (velocity needs 24h max, 2x safety margin).
    Data >= keep_hours old: keep 1 snapshot per market per hour-bucket, delete the rest.
    """
    try:
        deleted = conn.execute(
            "DELETE FROM odds_snapshots WHERE id NOT IN ("
            "  SELECT id FROM odds_snapshots "
            "  WHERE ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' hours')"
            "  UNION ALL"
            "  SELECT MIN(id) FROM odds_snapshots "
            "  WHERE ts <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? || ' hours') "
            "  GROUP BY market_id, strftime('%Y-%m-%dT%H', ts)"
            ")",
            (f"-{keep_hours}", f"-{keep_hours}"),
        ).rowcount
        if deleted:
            conn.commit()
            log.info(f"Pruned {deleted} old odds snapshots (kept 1/hour beyond {keep_hours}h)")
    except Exception as e:
        log.warning(f"Failed to prune snapshots: {e}")


def get_tracked_markets(conn) -> list[dict]:
    """Get all tracked markets with their latest odds."""
    rows = conn.execute(
        "SELECT market_id, question, slug, yes_price, no_price, volume, end_date, first_seen, last_seen "
        "FROM musk_markets ORDER BY last_seen DESC"
    ).fetchall()
    return [dict(r) for r in rows]
