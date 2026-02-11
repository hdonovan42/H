"""Market data fetchers — CoinGecko (crypto) + Yahoo Finance (fallback). SQLite cache."""

import json
import logging
from datetime import datetime, timezone, timedelta
import httpx
import yfinance as yf
from vault.config_loader import load_config

log = logging.getLogger("vault.market")

# CoinGecko ID mapping
COINGECKO_IDS = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
}

# Yahoo Finance ticker mapping (crypto pairs)
YAHOO_TICKERS = {
    "BTC": "BTC-USD",
    "ETH": "ETH-USD",
    "SOL": "SOL-USD",
}


def _cache_fresh(conn, asset: str, source: str) -> dict | None:
    """Check if cached price is still fresh."""
    cfg = load_config()
    ttl = cfg["market_data"]["cache_ttl_seconds"]

    row = conn.execute(
        "SELECT price_usd, fetched_at, data_json FROM market_cache WHERE asset = ? AND source = ?",
        (asset, source),
    ).fetchone()

    if not row:
        return None

    fetched = datetime.fromisoformat(row["fetched_at"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) - fetched < timedelta(seconds=ttl):
        return {
            "asset": asset,
            "price": row["price_usd"],
            "source": source,
            "cached": True,
            "fetched_at": row["fetched_at"],
        }
    return None


def _save_cache(conn, asset: str, source: str, price: float, data: dict | None = None):
    conn.execute(
        "INSERT INTO market_cache (asset, source, price_usd, data_json) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(asset, source) DO UPDATE SET price_usd=excluded.price_usd, "
        "fetched_at=excluded.fetched_at, data_json=excluded.data_json",
        (asset, source, price, json.dumps(data) if data else None),
    )
    conn.commit()


def fetch_coingecko(conn, asset: str) -> dict | None:
    """Fetch price from CoinGecko free API."""
    cached = _cache_fresh(conn, asset, "coingecko")
    if cached:
        return cached

    cg_id = COINGECKO_IDS.get(asset)
    if not cg_id:
        return None

    cfg = load_config()
    base = cfg["market_data"]["coingecko_base"]

    try:
        resp = httpx.get(
            f"{base}/simple/price",
            params={"ids": cg_id, "vs_currencies": "usd", "include_24hr_change": "true"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        price = data[cg_id]["usd"]
        change_24h = data[cg_id].get("usd_24h_change")

        _save_cache(conn, asset, "coingecko", price, data[cg_id])
        log.info(f"CoinGecko: {asset} = ${price:,.2f} (24h: {change_24h:+.2f}%)" if change_24h else f"CoinGecko: {asset} = ${price:,.2f}")

        return {
            "asset": asset,
            "price": price,
            "change_24h_pct": change_24h,
            "source": "coingecko",
            "cached": False,
        }
    except Exception as e:
        log.warning(f"CoinGecko fetch failed for {asset}: {e}")
        return None


def fetch_yahoo(conn, asset: str) -> dict | None:
    """Fetch price from Yahoo Finance (fallback)."""
    cached = _cache_fresh(conn, asset, "yahoo")
    if cached:
        return cached

    ticker = YAHOO_TICKERS.get(asset)
    if not ticker:
        return None

    try:
        tk = yf.Ticker(ticker)
        info = tk.fast_info
        price = info.last_price

        if price is None or price <= 0:
            return None

        _save_cache(conn, asset, "yahoo", price)
        log.info(f"Yahoo: {asset} = ${price:,.2f}")

        return {
            "asset": asset,
            "price": price,
            "source": "yahoo",
            "cached": False,
        }
    except Exception as e:
        log.warning(f"Yahoo fetch failed for {asset}: {e}")
        return None


def get_price(conn, asset: str) -> dict | None:
    """Get price from best available source. CoinGecko first, Yahoo fallback."""
    result = fetch_coingecko(conn, asset)
    if result:
        return result
    return fetch_yahoo(conn, asset)


def get_all_prices(conn) -> dict[str, dict]:
    """Fetch prices for all allowed assets."""
    cfg = load_config()
    assets = cfg["trading"]["allowed_assets"]
    prices = {}
    for asset in assets:
        data = get_price(conn, asset)
        if data:
            prices[asset] = data
    return prices
