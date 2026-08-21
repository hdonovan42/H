#!/usr/bin/env python3
"""STOCK.py — snappy US-equity lookups. No state, no ledger; see PORTFOLIO for that."""
from __future__ import annotations

import sys
import time
from datetime import datetime
from math import floor, log10
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

# One Yahoo call carries every field below *and* the intraday series. Finnhub
# was measured at ~906ms median against Yahoo's ~94ms and adds nothing we
# display, so it isn't used. 5m bars: 78 per session, a natural terminal width.
QUOTE_URL = WORKER_BASE + "/yahoo/{}?interval=5m&range=1d"

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
                closes = bars.get("close") or []
                points = [(t, c) for t, c in zip(result.get("timestamp", []), closes)
                          if c is not None]
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
                    "points": points,
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


def sig3(value: float) -> str:
    """Three significant figures, in plain notation — 365.63 -> 366,
    45.678 -> 45.7, 3409.5 -> 3,410. `%.3g` would give 3.41e+03."""
    if not value:
        return "0"
    places = 2 - floor(log10(abs(value)))
    rounded = round(value, places)
    return f"{rounded:,.{max(places, 0)}f}"


# Braille cells pack a 2x4 grid of dots, so one character row is 4 plot rows
# and one column is 2 — a far truer line than block characters manage.
BRAILLE = ((0x01, 0x08), (0x02, 0x10), (0x04, 0x20), (0x40, 0x80))
CHART_ROWS = 7


def chart_lines(points: list[tuple[int, float]], prev: float,
                colour: str, width: int) -> list[str]:
    """Braille line chart of the session. Scaled to the session's own range —
    including prev close would flatten the line on a big gap day — with prev
    drawn as a dotted rule when it happens to fall inside that range."""
    values = [v for _, v in points]
    stride = len(values) / width
    sample = [values[min(len(values) - 1, int(i * stride))] for i in range(width)]

    low, high = min(sample), max(sample)
    pad = (high - low) * 0.08 or 1.0
    low, high = low - pad, high + pad
    span = high - low
    height = CHART_ROWS * 4

    grid = [[0] * width for _ in range(CHART_ROWS)]

    def dot(x: int, y: int) -> None:
        if 0 <= y < height and 0 <= x < width * 2:
            grid[y // 4][x // 2] |= BRAILLE[y % 4][x % 2]

    previous_y = None
    for i, value in enumerate(sample):
        y = int((high - value) / span * (height - 1))
        x = i * 2
        if previous_y is not None:  # join consecutive samples into a line
            for fill in range(min(previous_y, y), max(previous_y, y) + 1):
                dot(x, fill)
        dot(x, y)
        dot(x + 1, y)
        previous_y = y

    prev_row = int((high - prev) / span * (height - 1)) // 4 if low <= prev <= high else None

    lines = []
    for row, cells in enumerate(grid):
        drawn = "".join(chr(0x2800 + c) if c else " " for c in cells)
        if row == prev_row:
            drawn = "".join(c if c != " " else "[dim]·[/dim]" for c in drawn)
        if row == 0:
            label = f"{sig3(high):>9}"
        elif row == CHART_ROWS - 1:
            label = f"{sig3(low):>9}"
        else:
            label = " " * 9
        lines.append(f"[dim]{label}[/dim] [{colour}]{drawn}[/{colour}]")

    opened = datetime.fromtimestamp(points[0][0], EXCHANGE_TZ)
    latest = datetime.fromtimestamp(points[-1][0], EXCHANGE_TZ)
    axis_gap = max(1, width - 10)
    lines.append(f"[dim]{' ' * 10}{opened:%H:%M}{' ' * axis_gap}{latest:%H:%M}[/dim]")
    if prev_row is not None:          # only worth a legend when the rule is drawn
        lines.append("[dim]· prev close[/dim]")
    return lines


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

    points = quote.get("points") or []
    if is_open and len(points) >= 3:
        width = max(24, min(56, console.width - 24))
        body += "\n\n" + "\n".join(chart_lines(points, quote["prev"], colour, width))

    stale = "" if is_open else "  ·  last close"
    console.print(Panel(body, title=f"{quote['name']} ({quote['ticker']})",
                        subtitle=f" {status}  ·  {quote['exchange']}  ·  {now:%H:%M %Z}{stale}"
                                 + (" · 5m bars " if (is_open and len(points) >= 3) else " "),
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
