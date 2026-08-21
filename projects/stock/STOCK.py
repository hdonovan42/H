#!/usr/bin/env python3
"""STOCK.py — snappy US-equity lookups. No state, no ledger; see PORTFOLIO for that."""
from __future__ import annotations

import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent

try:
    import click
    import requests
    from rich import box
    from rich.console import Console
    from rich.panel import Panel
except ModuleNotFoundError as e:
    print(f"\n  ✗ Missing Python dependency: {e.name}\n")
    print(f"  Install:\n\n      pip install -r {SCRIPT_DIR / 'requirements.txt'}\n")
    print("  On PEP 668 systems (Debian/Ubuntu 23.04+), add --user --break-system-packages")
    print("  or use a virtualenv. Then re-run.\n")
    sys.exit(1)

WORKER_BASE = "https://dry-poetry-72b5.donovanh59.workers.dev"
TIMEOUT = 5
RETRIES = 3

# One Yahoo call carries every field below. Finnhub was measured at ~906ms
# median against Yahoo's ~94ms and adds nothing we display, so it isn't used.
QUOTE_URL = WORKER_BASE + "/yahoo/{}?interval=1d&range=1d"

EXCHANGE_TZ = ZoneInfo("America/New_York")
OPEN_MINUTE, CLOSE_MINUTE = 9 * 60 + 30, 16 * 60   # 09:30–16:00 ET
FRESH_SECONDS = 300                                # a tick this recent = live tape

console = Console()


def fetch(ticker: str) -> Optional[dict]:
    """The worker intermittently answers with an empty or non-JSON body,
    so retry on parse failure rather than on HTTP status alone."""
    url = QUOTE_URL.format(ticker)
    for attempt in range(RETRIES):
        try:
            r = requests.get(url, timeout=TIMEOUT)
            if r.ok and r.content:
                result = r.json()["chart"]["result"][0]
                meta, bars = result["meta"], result["indicators"]["quote"][0]
                price = float(meta["regularMarketPrice"])
                prev = float(meta.get("chartPreviousClose") or price)
                opens = [o for o in (bars.get("open") or []) if o is not None]
                return {
                    "ticker": meta.get("symbol", ticker),
                    "name": meta.get("longName") or meta.get("shortName") or ticker,
                    "exchange": meta.get("fullExchangeName", "?"),
                    "price": price,
                    "prev": prev,
                    "open": opens[0] if opens else None,
                    "high": meta.get("regularMarketDayHigh"),
                    "low": meta.get("regularMarketDayLow"),
                    "traded_at": meta.get("regularMarketTime", 0),
                    "change": price - prev,
                    "change_pct": (price - prev) / prev * 100 if prev else 0.0,
                }
        except (requests.RequestException, ValueError, KeyError, IndexError, TypeError):
            pass
        if attempt < RETRIES - 1:
            time.sleep(0.3)
    return None


def market_open(quote: dict) -> tuple[bool, datetime]:
    """Open iff we're inside the ET session AND the tape is moving. The
    freshness half is what handles market holidays without a holiday calendar."""
    now = datetime.now(EXCHANGE_TZ)
    minute = now.hour * 60 + now.minute
    in_session = now.weekday() < 5 and OPEN_MINUTE <= minute < CLOSE_MINUTE
    fresh = (time.time() - quote["traded_at"]) < FRESH_SECONDS
    return in_session and fresh, now


def render(quote: dict, plain: bool) -> None:
    is_open, now = market_open(quote)
    status = "[bold green]● OPEN[/bold green]" if is_open else "[bold red]● CLOSED[/bold red]"
    colour = "green" if is_open else "red"
    move = "green" if quote["change"] >= 0 else "red"
    delta = f"[{move}]{quote['change']:+,.2f} ({quote['change_pct']:+.2f}%)[/{move}]"

    if plain:
        console.print(f"[bold]{quote['ticker']}[/bold]  "
                      f"[bold white]${quote['price']:,.2f}[/bold white]  {delta}  {status}")
        return

    stats = [f"[dim]{label}[/dim] {quote[key]:,.2f}"
             for label, key in (("open", "open"), ("high", "high"), ("low", "low"), ("prev", "prev"))
             if quote.get(key) is not None]
    body = f"[bold white]${quote['price']:,.2f}[/bold white]   {delta}\n" + "   ".join(stats)
    stale = "" if is_open else "  ·  last close"
    console.print(Panel(body, title=f"{quote['name']} ({quote['ticker']})",
                        subtitle=f" {status}  ·  {quote['exchange']}  ·  {now:%H:%M %Z}{stale} ",
                        border_style=colour, padding=(1, 2), box=box.ROUNDED, expand=False))


@click.command()
@click.argument("ticker")
@click.option("--plain", is_flag=True, help="One-line output, for scripting.")
@click.version_option("0.1.0", prog_name="stock")
def cli(ticker: str, plain: bool) -> None:
    """Current price and market status for a US-listed TICKER.

    \b
        stock TSLA          price, day move, market status
        stock TSLA --plain  one line, no box
    """
    symbol = ticker.strip().rstrip("?").upper()
    if not symbol:
        raise click.BadParameter("no ticker given")

    quote = fetch(symbol)
    if quote is None:
        console.print(f"[red]✗[/red] No quote for [bold]{symbol}[/bold] "
                      f"[dim](unknown ticker, or the price feed is down)[/dim]")
        sys.exit(1)
    render(quote, plain)


if __name__ == "__main__":
    cli()
