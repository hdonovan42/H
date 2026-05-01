"""Polymarket API client — Gamma API for market discovery and resolution."""

import json
import logging
from datetime import datetime, timezone, timedelta
from vault.config_loader import load_config
from vault.http_utils import http_get_with_retry

log = logging.getLogger("vault.polymarket")

GAMMA_BASE = "https://gamma-api.polymarket.com"


def _cache_fresh(conn, market_id: str) -> dict | None:
    """Check if cached market data is still fresh."""
    cfg = load_config()
    ttl = cfg.get("polymarket", {}).get("cache_ttl_seconds", 300)

    row = conn.execute(
        "SELECT price_usd, fetched_at, data_json FROM market_cache WHERE asset = ? AND source = ?",
        (f"pm_{market_id}", "polymarket"),
    ).fetchone()

    if not row:
        return None

    fetched = datetime.fromisoformat(row["fetched_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) - fetched < timedelta(seconds=ttl):
        try:
            return json.loads(row["data_json"])
        except (json.JSONDecodeError, TypeError):
            return None
    return None


def _save_cache(conn, market_id: str, data: dict, yes_price: float | None):
    """Save market data to cache. yes_price may be None when the gamma API
    didn't return outcomePrices for this fetch — see _parse_market."""
    conn.execute(
        "INSERT INTO market_cache (asset, source, price_usd, data_json) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(asset, source) DO UPDATE SET price_usd=excluded.price_usd, "
        "fetched_at=excluded.fetched_at, data_json=excluded.data_json",
        (f"pm_{market_id}", "polymarket", yes_price, json.dumps(data)),
    )
    conn.commit()


def fetch_market(conn, market_id: str) -> dict | None:
    """Fetch a single market by ID. Uses cache."""
    cached = _cache_fresh(conn, market_id)
    if cached:
        return cached

    try:
        resp = http_get_with_retry(f"{GAMMA_BASE}/markets/{market_id}")
        market = resp.json()
        parsed = _parse_market(market)
        if parsed:
            # Don't cache when prices are missing — caching the parsed dict
            # without prices (yes_price=None) is fine, but caching the
            # *price index* needs a real value. Skip the price-indexed cache
            # update when has_prices is False so we don't poison odds_history
            # readers downstream.
            if parsed.get("has_prices"):
                _save_cache(conn, market_id, parsed, parsed["yes_price"])
            else:
                # Still cache the metadata (volume, end_date, etc.) but mark
                # the price entry None so callers know not to trust it.
                _save_cache(conn, market_id, parsed, None)
        return parsed
    except Exception as e:
        log.warning(f"Failed to fetch market {market_id}: {e}")
        return None


def fetch_trending(conn, limit: int = 5) -> list[dict]:
    """Fetch trending markets sorted by volume, filtering out extreme-odds markets."""
    cfg = load_config()
    n = cfg.get("polymarket", {}).get("trending_count", limit)

    try:
        # Fetch more than needed so we have enough after filtering extremes
        fetch_count = max(n * 4, 20)
        resp = http_get_with_retry(
            f"{GAMMA_BASE}/markets",
            params={
                "active": "true",
                "closed": "false",
                "order": "volume",
                "ascending": "false",
                "limit": fetch_count,
            },
        )
        markets = resp.json()

        results = []
        for m in markets:
            parsed = _parse_market(m)
            if not parsed:
                continue
            # Filter out extreme-odds markets (resolved-in-all-but-name)
            yes = parsed["yes_price"]
            if yes < 0.05 or yes > 0.95:
                continue
            _save_cache(conn, parsed["id"], parsed, yes)
            results.append(parsed)
            if len(results) >= n:
                break

        log.info(f"Fetched {len(results)} trending markets from Polymarket (filtered extremes)")
        return results
    except Exception as e:
        log.warning(f"Failed to fetch trending markets: {e}")
        return []


def search_markets(conn, query: str, limit: int = 10) -> list[dict]:
    """Search markets by query string."""
    try:
        resp = http_get_with_retry(
            f"{GAMMA_BASE}/markets",
            params={
                "active": "true",
                "closed": "false",
                "limit": limit,
                "slug_keyword": query,
            },
        )
        markets = resp.json()

        results = []
        for m in markets:
            parsed = _parse_market(m)
            if parsed:
                results.append(parsed)
        return results
    except Exception as e:
        log.warning(f"Failed to search markets for '{query}': {e}")
        return []


def check_resolution(conn, market_id: str) -> dict | None:
    """Check if a market has resolved. Returns resolution info or None if still open.

    Returns: {"resolved": True, "winner": "YES"|"NO"} or None
    """
    try:
        resp = http_get_with_retry(f"{GAMMA_BASE}/markets/{market_id}")
        market = resp.json()

        closed = market.get("closed", False)
        if not closed:
            return None

        # Parse outcome prices to determine winner
        outcome_prices = market.get("outcomePrices")
        if not outcome_prices:
            return None

        if isinstance(outcome_prices, str):
            try:
                outcome_prices = json.loads(outcome_prices)
            except json.JSONDecodeError:
                return None

        # outcomePrices is [yes_price, no_price] — winner has price 1
        if len(outcome_prices) >= 2:
            yes_price = float(outcome_prices[0])
            no_price = float(outcome_prices[1])
            if yes_price >= 0.99:
                return {"resolved": True, "winner": "YES"}
            elif no_price >= 0.99:
                return {"resolved": True, "winner": "NO"}

        return None
    except Exception as e:
        log.warning(f"Failed to check resolution for {market_id}: {e}")
        return None


def get_current_odds(conn, market_id: str) -> dict | None:
    """Get current YES/NO prices for a market.

    Returns None if the gamma API didn't include outcomePrices in this fetch
    (rare but observed). Returning a 50/50 placeholder here is wrong — it
    poisons MTM, snapshots, and peak_roi tracking.
    """
    market = fetch_market(conn, market_id)
    if not market:
        return None
    if not market.get("has_prices"):
        log.warning(f"Market {market_id}: gamma API returned no outcomePrices; treating as unknown")
        return None
    return {"yes_price": market["yes_price"], "no_price": market["no_price"]}


def _parse_clob_token_ids(raw_value) -> list | None:
    """Parse clobTokenIds — same string/list handling as outcomePrices."""
    if not raw_value:
        return None
    if isinstance(raw_value, str):
        try:
            parsed = json.loads(raw_value)
            return parsed if isinstance(parsed, list) else None
        except json.JSONDecodeError:
            return None
    if isinstance(raw_value, list):
        return raw_value
    return None


def _parse_market(raw: dict) -> dict | None:
    """Parse raw Gamma API market into clean dict."""
    if not raw:
        return None

    market_id = raw.get("id")
    if not market_id:
        return None

    # Parse outcome prices. The gamma API has been observed to return market
    # records without outcomePrices populated for short windows (e.g. immediately
    # after a stale-cache refresh). Previously we silently defaulted to 0.5/0.5,
    # which poisoned odds_snapshots and peak_roi (Apr 28 2026 incident — pred #12
    # peak_roi inflated to +146% from a 20-minute window of bogus 50/50 reads).
    # Now: set None and let callers detect missing data via has_prices.
    outcome_prices = raw.get("outcomePrices")
    yes_price = None
    no_price = None
    has_prices = False
    if outcome_prices:
        if isinstance(outcome_prices, str):
            try:
                outcome_prices = json.loads(outcome_prices)
            except json.JSONDecodeError:
                outcome_prices = None
        if outcome_prices and len(outcome_prices) >= 2:
            yes_price = float(outcome_prices[0])
            no_price = float(outcome_prices[1])
            has_prices = True

    # Extract parent event title if available
    events = raw.get("events")
    event_title = ""
    if events and isinstance(events, list) and len(events) > 0:
        event_title = events[0].get("title", "")

    return {
        "id": str(market_id),
        "condition_id": raw.get("conditionId"),
        "question": raw.get("question", ""),
        "slug": raw.get("slug"),
        "yes_price": yes_price,
        "no_price": no_price,
        "has_prices": has_prices,
        "volume": float(raw.get("volume", 0) or 0),
        "end_date": raw.get("endDate"),
        # `closed` and `accepting_orders` default to None (not False/True) so
        # a missing field doesn't quietly assert "tradeable". Callers must do
        # explicit equality checks (e.g. `if market.get("closed") is True`).
        "closed": raw.get("closed"),
        "accepting_orders": raw.get("acceptingOrders"),
        "clob_token_ids": _parse_clob_token_ids(raw.get("clobTokenIds")),
        # Enriched fields from Gamma API
        "volume_24h": float(raw.get("volume24hr", 0) or 0),
        "liquidity": float(raw.get("liquidityClob", 0) or 0),
        "spread": float(raw.get("spread", 0) or 0),
        "best_bid": float(raw.get("bestBid", 0) or 0),
        "best_ask": float(raw.get("bestAsk", 0) or 0),
        "competitive": float(raw.get("competitive", 0) or 0),
        "description": raw.get("description", ""),
        "start_date": raw.get("startDate"),
        "game_start_time": raw.get("gameStartTime"),
        "group_item_title": raw.get("groupItemTitle"),
        "event_title": event_title,
    }
