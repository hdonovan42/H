#!/usr/bin/env python3
"""PORTFOLIO.py — stock portfolio tracker. Data lives in ~/.portfolio-vault/."""
from __future__ import annotations

import bisect
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

SCRIPT_DIR = Path(__file__).resolve().parent

try:
    import click
    import requests
    from rich.console import Console
    from rich.panel import Panel
    from rich.prompt import Prompt
    from rich.table import Table
except ModuleNotFoundError as e:
    print(f"\n  ✗ Missing Python dependency: {e.name}\n")
    print(f"  Install all deps:\n")
    print(f"      pip install -r {SCRIPT_DIR / 'requirements.txt'}\n")
    print(f"  On PEP 668 systems (Debian/Ubuntu 23.04+), add --user --break-system-packages")
    print(f"  or use a virtualenv. Then re-run.\n")
    sys.exit(1)

VAULT_DIR = Path.home() / ".portfolio-vault"
DATA_FILE = VAULT_DIR / "portfolio.json"
WORKER_BASE = "https://dry-poetry-72b5.donovanh59.workers.dev"

console = Console()


def require_vault() -> None:
    if VAULT_DIR.exists():
        return
    setup_script = SCRIPT_DIR / "setup-vault.sh"
    alias_target = SCRIPT_DIR / "PORTFOLIO.py"
    body = (
        "[bold]First-run setup needed on this machine.[/bold]\n\n"
        f"The data vault at [cyan]{VAULT_DIR}[/cyan] doesn't exist yet.\n"
        "Your trades live in a separate private repo "
        "([cyan]github.com/hdonovan42/PORTFOLIO[/cyan]); this clones it.\n\n"
        "[bold yellow]Steps[/bold yellow]\n\n"
        f"  [green]1.[/green] Confirm your git/gh auth can read the private "
        "[cyan]hdonovan42/PORTFOLIO[/cyan] repo on this machine.\n\n"
        f"  [green]2.[/green] Clone the data vault:\n"
        f"        [bold]bash {setup_script}[/bold]\n\n"
        f"  [green]3.[/green] (optional) Add the [bold]portfolio[/bold] alias so you can run it from anywhere:\n"
        f"        [bold]echo 'alias portfolio=\"python3 {alias_target}\"' >> ~/.bashrc[/bold]\n"
        f"        [bold]source ~/.bashrc[/bold]\n\n"
        "Re-run [bold]portfolio[/bold] when done."
    )
    console.print(Panel(body, title="PORTFOLIO bootstrap", border_style="yellow", padding=(1, 2)))
    sys.exit(1)


# ─── state ────────────────────────────────────────────────────────────────────

def load_state() -> dict:
    require_vault()
    if not DATA_FILE.exists():
        return {"version": 1, "transactions": [], "positions": {}}
    with DATA_FILE.open() as f:
        state = json.load(f)
    state["positions"] = recompute_positions(state["transactions"])
    return state


def recompute_positions(transactions: list[dict]) -> dict[str, int]:
    positions: dict[str, int] = {}
    for tx in transactions:
        delta = tx["quantity"] if tx["action"] == "BUY" else -tx["quantity"]
        positions[tx["ticker"]] = positions.get(tx["ticker"], 0) + delta
    return {t: q for t, q in positions.items() if q != 0}


def save_state(state: dict) -> None:
    tmp = DATA_FILE.with_suffix(".json.tmp")
    with tmp.open("w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")
    os.replace(tmp, DATA_FILE)


# ─── redundancy ───────────────────────────────────────────────────────────────

def _run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return result.returncode, (result.stderr or result.stdout).strip()


def commit_vault(message: str) -> None:
    rc, err = _run(["git", "add", "portfolio.json"], VAULT_DIR)
    if rc != 0:
        console.print(f"[yellow]⚠ vault git add failed: {err}[/yellow]")
        return
    rc, _ = _run(["git", "diff", "--cached", "--quiet"], VAULT_DIR)
    if rc == 0:
        return  # nothing staged
    rc, err = _run(["git", "commit", "-m", message], VAULT_DIR)
    if rc != 0:
        console.print(f"[yellow]⚠ vault commit failed: {err}[/yellow]")
        return
    rc, err = _run(["git", "push"], VAULT_DIR)
    if rc != 0:
        console.print(f"[yellow]⚠ vault push failed (commit kept locally): {err}[/yellow]")


def persist(state: dict, message: str) -> None:
    save_state(state)
    commit_vault(message)


# ─── prices ───────────────────────────────────────────────────────────────────

def fetch_price(ticker: str) -> Optional[float]:
    try:
        r = requests.get(f"{WORKER_BASE}/finnhub/quote/{ticker}", timeout=5)
        if r.ok:
            price = r.json().get("c")
            if price:
                return float(price)
    except (requests.RequestException, ValueError):
        pass
    try:
        # Yahoo v8 chart via the worker (the old /yahoo-quote route is gone)
        r = requests.get(f"{WORKER_BASE}/yahoo/{ticker}?interval=1d&range=1d", timeout=5)
        if r.ok:
            result = (r.json().get("chart") or {}).get("result") or []
            if result:
                price = (result[0].get("meta") or {}).get("regularMarketPrice")
                if price:
                    return float(price)
    except (requests.RequestException, ValueError):
        pass
    return None


# ─── S&P 500 benchmark ────────────────────────────────────────────────────────

SP500_TICKER = "^SP500TR"  # S&P 500 Total Return index: dividends reinvested
SP500_FIRST_DAY = date(1988, 1, 4)  # the index's first close on Yahoo
CACHE_DIR = Path.home() / ".cache" / "portfolio"
SP500_CACHE_FILE = CACHE_DIR / "sp500tr.json"


def _fetch_sp500(since: date) -> list[list]:
    """Daily [date, close] rows of the index from `since` to now, via the worker."""
    p1 = int(datetime(since.year, since.month, since.day, tzinfo=timezone.utc).timestamp())
    p2 = int(datetime.now(timezone.utc).timestamp())
    r = requests.get(
        f"{WORKER_BASE}/yahoo/{SP500_TICKER}?interval=1d&period1={p1}&period2={p2}",
        timeout=30,
    )
    result = (r.json().get("chart") or {}).get("result") or []
    if not result:
        return []  # nothing traded in the window (weekend, holiday)
    closes = ((result[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    return [
        [datetime.fromtimestamp(ts, timezone.utc).date().isoformat(), round(px, 4)]
        for ts, px in zip(result[0].get("timestamp") or [], closes)
        if px is not None
    ]


def load_sp500(end: date) -> list[list]:
    """Daily closes of the index from 1988 up to at least `end` (when traded).

    A day's close never changes once the day is over, so the full history is
    downloaded once into ~/.cache/portfolio/ and later runs fetch only the days
    after the last one stored — nothing at all when `end` is already covered.
    Today's bar is a live price until the market closes: it is used, not stored.
    """
    series: list[list] = []
    try:
        series = json.loads(SP500_CACHE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        series = []
    last = series[-1][0] if series else None
    if last is not None and end.isoformat() <= last:
        return series
    since = date.fromisoformat(last) + timedelta(days=1) if last else SP500_FIRST_DAY
    try:
        fresh = [row for row in _fetch_sp500(since) if last is None or row[0] > last]
    except (requests.RequestException, ValueError) as e:
        if not series:
            raise click.ClickException(f"cannot download S&P 500 data: {e}")
        console.print(f"[yellow]⚠ S&P 500 download failed ({e}); using closes up to {last}[/yellow]")
        return series
    today = date.today().isoformat()
    settled = [row for row in fresh if row[0] < today]
    if settled:
        series = series + settled
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = SP500_CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(series) + "\n")
        os.replace(tmp, SP500_CACHE_FILE)
    series = series + [row for row in fresh if row[0] >= today]
    if not series:
        raise click.ClickException("Yahoo returned no S&P 500 data")
    return series


def nearest_close(series: list[list], target: date) -> tuple[date, float]:
    """The index close on the trading day nearest to target, within a week."""
    i = bisect.bisect_left(series, [target.isoformat()])
    day, px = min(
        (series[j] for j in (i - 1, i) if 0 <= j < len(series)),
        key=lambda row: abs((date.fromisoformat(row[0]) - target).days),
    )
    if abs((date.fromisoformat(day) - target).days) > 7:
        raise click.ClickException(f"no S&P 500 close within a week of {target}")
    return date.fromisoformat(day), px


def parse_flex_date(raw: str, label: str) -> date:
    s = raw.strip()
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise click.ClickException(f"{label} must be YYYY, YYYY-MM or YYYY-MM-DD — got '{raw}'")


def fetch_adjclose_near(ticker: str, target: date) -> tuple[date, float]:
    """Nearest adjusted close to target within ±7 days, via the worker's Yahoo route."""
    p1 = int(datetime(target.year, target.month, target.day, tzinfo=timezone.utc).timestamp()) - 7 * 86400
    p2 = p1 + 15 * 86400
    try:
        r = requests.get(
            f"{WORKER_BASE}/yahoo/{ticker}?interval=1d&period1={p1}&period2={p2}",
            timeout=10,
        )
        payload = r.json()
    except (requests.RequestException, ValueError) as e:
        raise click.ClickException(f"Yahoo lookup failed for {ticker}: {e}")
    chart = payload.get("chart") or {}
    result = chart.get("result") or []
    if not result:
        detail = (chart.get("error") or {}).get("description") or "no data"
        # A window predating the ticker errors outright — fetch meta for a
        # friendlier hint than Yahoo's raw epoch message.
        try:
            m = requests.get(f"{WORKER_BASE}/yahoo/{ticker}?interval=1d&range=1d", timeout=10).json()
            first = (((m.get("chart") or {}).get("result") or [{}])[0].get("meta") or {}).get("firstTradeDate")
            if first:
                first_d = datetime.fromtimestamp(first, timezone.utc).date()
                if target < first_d:
                    raise click.ClickException(f"{ticker} has no data at {target} — its history starts {first_d}")
        except (requests.RequestException, ValueError, KeyError, IndexError):
            pass
        raise click.ClickException(f"Yahoo has no data for {ticker}: {detail}")
    timestamps = result[0].get("timestamp") or []
    adj = ((result[0].get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose") or []
    candidates = [
        (datetime.fromtimestamp(ts, timezone.utc).date(), px)
        for ts, px in zip(timestamps, adj)
        if px is not None
    ]
    if not candidates:
        hint = ""
        first = (result[0].get("meta") or {}).get("firstTradeDate")
        if first:
            hint = f" — its history starts {datetime.fromtimestamp(first, timezone.utc).date()}"
        raise click.ClickException(f"no {ticker} trading data near {target}{hint}")
    return min(candidates, key=lambda c: abs((c[0] - target).days))


# ─── tables ───────────────────────────────────────────────────────────────────

def render_positions(positions: dict[str, int], title: str) -> Table:
    table = Table(title=title, header_style="bold cyan", title_style="bold")
    table.add_column("Ticker", style="white")
    table.add_column("Quantity", justify="right", style="green")
    if not positions:
        table.add_row("—", "—")
    else:
        for ticker in sorted(positions):
            table.add_row(ticker, str(positions[ticker]))
    return table


def render_value_table(positions: dict[str, int]) -> Table:
    now_local = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    table = Table(title=f"Portfolio (live) — {now_local}", header_style="bold cyan", title_style="bold")
    table.add_column("Ticker", style="white")
    table.add_column("Quantity", justify="right", style="green")
    table.add_column("Price (USD)", justify="right")
    table.add_column("Value (USD)", justify="right", style="bold")
    table.add_column("Weight", justify="right")
    if not positions:
        table.add_row("—", "—", "—", "—", "—")
        return table
    rows = [(ticker, positions[ticker], fetch_price(ticker)) for ticker in sorted(positions)]
    total = sum(price * qty for _, qty, price in rows if price is not None)
    # heaviest first; unpriced rows sink to the bottom (alphabetical among themselves)
    rows.sort(key=lambda r: -(r[2] * r[1]) if r[2] is not None else float("inf"))
    for ticker, qty, price in rows:
        if price is None:
            table.add_row(ticker, str(qty), "—", "—", "—")
        else:
            value = price * qty
            weight = f"{value / total * 100:.1f}%" if total else "—"
            table.add_row(ticker, str(qty), f"{price:,.2f}", f"{value:,.2f}", weight)
    table.add_section()
    table.add_row("TOTAL", "", "", f"{total:,.2f}", "100.0%" if total else "—")
    if any(price is None for _, _, price in rows):
        table.caption = "[yellow]some prices unavailable — total & weights exclude them[/yellow]"
    return table


# ─── price resolution ─────────────────────────────────────────────────────────

def _prompt_price(ticker: str) -> float:
    return _validate_price(Prompt.ask(f"Enter price for {ticker} (USD)"))


def resolve_price(ticker: str, price: Optional[float]) -> float:
    """Return the trade price: the one supplied, else prompt (current vs manual)."""
    if price is not None:
        return price
    current = fetch_price(ticker)
    if current is None:
        console.print(f"[yellow]No live price available for {ticker}.[/yellow]")
        return _prompt_price(ticker)
    choice = Prompt.ask(
        f"No price given. [1] at current price ([green]${current:,.2f}[/green])  [2] enter price",
        choices=["1", "2"],
        default="1",
    )
    return current if choice == "1" else _prompt_price(ticker)


# ─── mutation ─────────────────────────────────────────────────────────────────

def apply_transaction(state: dict, action: str, ticker: str, quantity: int, price: float) -> dict:
    tx = {
        "id": len(state["transactions"]) + 1,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "action": action,
        "ticker": ticker,
        "quantity": quantity,
        "price": price,
    }
    state["transactions"].append(tx)
    state["positions"] = recompute_positions(state["transactions"])
    return state


def execute(action: str, ticker: str, quantity: int, price: Optional[float]) -> None:
    state = load_state()
    if action == "SELL":
        held = state["positions"].get(ticker, 0)
        if quantity > held:
            raise click.ClickException(f"cannot SELL {quantity} {ticker} — only hold {held}")
    console.print(render_positions(state["positions"], "Before"))
    resolved = resolve_price(ticker, price)
    state = apply_transaction(state, action, ticker, quantity, resolved)
    message = f"portfolio: {action} {ticker} {quantity} @ {resolved:,.2f}"
    persist(state, message)
    console.print(render_positions(state["positions"], "After"))
    console.print(f"[green]✓[/green] {message}")


# ─── CLI ──────────────────────────────────────────────────────────────────────

class OrderedGroup(click.Group):
    """List subcommands in declaration order rather than alphabetically."""

    def list_commands(self, ctx: click.Context) -> list[str]:
        return list(self.commands)


@click.group(cls=OrderedGroup, invoke_without_command=True)
@click.pass_context
def cli(ctx: click.Context) -> None:
    """PORTFOLIO — command-line stock portfolio tracker.

    \b
    Every buy and sell records a price. Give it explicitly with `@`:
        portfolio buy AAPL 10 @ 401.00
        portfolio sell AAPL 4 @ 415.50

    \b
    If price is left empty, enter interactively (current market price or manual):
        portfolio buy AAPL 10
        -> No price given. [1] at current price ($401.23)  [2] enter price

    \b
    Other commands:
        portfolio value      current holdings, live prices, weights + total value
        portfolio history    full transaction ledger (with recorded prices)
        portfolio sp500      S&P 500 return since any date (vs a ticker or a %)
        portfolio            interactive prompt (action / ticker / qty / price)
    """
    if ctx.invoked_subcommand is None:
        interactive()


def _validate_quantity(qty_str: str) -> int:
    try:
        qty = int(qty_str)
    except ValueError:
        raise click.ClickException(f"quantity must be an integer, got '{qty_str}'")
    if qty < 1:
        raise click.ClickException("quantity must be ≥ 1")
    return qty


def _validate_price(raw: str) -> float:
    try:
        price = float(str(raw).lstrip("@").strip().replace(",", ""))
    except ValueError:
        raise click.ClickException(f"price must be a number, got '{raw}'")
    if price <= 0:
        raise click.ClickException("price must be > 0")
    return price


def _parse_price_tokens(tokens: tuple[str, ...]) -> Optional[float]:
    """Parse the trailing `@ PRICE` tokens of a buy/sell. None when absent."""
    joined = " ".join(tokens).strip().lstrip("@").strip()
    if not joined:
        return None
    return _validate_price(joined)


@cli.command(context_settings={"ignore_unknown_options": True})
@click.argument("ticker")
@click.argument("quantity")
@click.argument("price", nargs=-1)
def buy(ticker: str, quantity: str, price: tuple[str, ...]) -> None:
    """Buy QUANTITY shares of TICKER, e.g. `buy AAPL 10 @ 401.00`.

    Omit the price to be asked for the current market price or your own.
    """
    execute("BUY", ticker.upper(), _validate_quantity(quantity), _parse_price_tokens(price))


@cli.command(context_settings={"ignore_unknown_options": True})
@click.argument("ticker")
@click.argument("quantity")
@click.argument("price", nargs=-1)
def sell(ticker: str, quantity: str, price: tuple[str, ...]) -> None:
    """Sell QUANTITY shares of TICKER, e.g. `sell AAPL 4 @ 415.50`.

    Omit the price to be asked for the current market price or your own.
    """
    execute("SELL", ticker.upper(), _validate_quantity(quantity), _parse_price_tokens(price))


@cli.command()
def value() -> None:
    """Show current portfolio with live prices, weights and total value."""
    state = load_state()
    console.print(render_value_table(state["positions"]))


@cli.command()
def history() -> None:
    """Show transaction history."""
    state = load_state()
    table = Table(title="Transactions", header_style="bold cyan", title_style="bold")
    table.add_column("#", justify="right")
    table.add_column("Timestamp")
    table.add_column("Action")
    table.add_column("Ticker")
    table.add_column("Quantity", justify="right")
    table.add_column("Price (USD)", justify="right")
    if not state["transactions"]:
        table.add_row("—", "—", "—", "—", "—", "—")
    else:
        for tx in state["transactions"]:
            colour = "green" if tx["action"] == "BUY" else "red"
            price = tx.get("price")
            price_str = f"{price:,.2f}" if price is not None else "—"
            table.add_row(
                str(tx["id"]),
                tx["ts"],
                f"[{colour}]{tx['action']}[/{colour}]",
                tx["ticker"],
                str(tx["quantity"]),
                price_str,
            )
    console.print(table)


@cli.command()
@click.argument("start")
@click.argument("end", required=False)
@click.option("--amount", type=float, default=None, help="Show growth of this dollar amount instead of $1.")
@click.option("--vs", "vs", default=None, metavar="TICKER|RETURN",
              help="Compare a ticker (e.g. AAPL) or a return you made (e.g. 412%) against the S&P 500.")
def sp500(start: str, end: Optional[str], amount: Optional[float], vs: Optional[str]) -> None:
    """What the S&P 500 returned from START to END (default: today).

    \b
    Total return: every dividend reinvested, as an index fund would have
    paid you (before its fees). Dates may be YYYY, YYYY-MM or YYYY-MM-DD,
    from 1988 on; each uses the close on the nearest trading day.
        portfolio sp500 2021-11
        portfolio sp500 2000 2010
        portfolio sp500 2015 --amount 10000 --vs AAPL
        portfolio sp500 2015 --vs 412%
    """
    start_d = parse_flex_date(start, "START")
    today = date.today()
    end_d = parse_flex_date(end, "END") if end else today
    if start_d.year < SP500_FIRST_DAY.year:
        raise click.ClickException(f"S&P 500 total-return data starts {SP500_FIRST_DAY} — choose a later START")
    if start_d > today:
        raise click.ClickException(f"START cannot be in the future (today is {today})")
    if end_d > today:
        raise click.ClickException(f"END cannot be in the future (today is {today})")
    if end_d <= start_d:
        raise click.ClickException("END must be after START")

    series = load_sp500(end_d)
    d0, px0 = nearest_close(series, start_d)
    d1, px1 = nearest_close(series, end_d)
    if d1 <= d0:
        raise click.ClickException(f"START and END fall on the same trading day ({d0}) — widen the window")
    factor = px1 / px0
    years = (d1 - d0).days / 365.25
    sp_ann = factor ** (1 / years) - 1

    principal = amount if amount is not None else 1.0
    growth_label = f"Growth of ${principal:,.2f}".replace(".00", "")

    def money(x: float) -> str:
        return f"${x:,.4f}" if principal == 1.0 else f"${x:,.2f}"

    def pct(x: float, dp: int = 1) -> str:
        return f"{x * 100:+,.{dp}f}%"

    table = Table(
        title=f"S&P 500 total return  {d0} → {d1}  ({years:,.1f}y)",
        title_style="bold",
        show_header=False,
        min_width=60,
    )
    table.add_column(style="white")
    table.add_column(justify="right", style="bold")
    table.add_row(growth_label, money(principal * factor))
    table.add_row("Total return", pct(factor - 1))
    table.add_row("Annualised", pct(sp_ann, 2) + "/yr")

    if vs:
        if re.fullmatch(r"[+-]?\d+(?:\.\d+)?\s*%?", vs.strip()):
            inv_total = float(vs.strip().rstrip("%").strip()) / 100
            inv_years = years
            heading = f"Your return ({vs.strip()})"
        else:
            # Adjusted closes are rescaled after every dividend, so they are
            # fetched fresh each run rather than cached like the index.
            ticker = vs.strip().upper()
            t0, tp0 = fetch_adjclose_near(ticker, d0)
            t1, tp1 = fetch_adjclose_near(ticker, d1)
            if t1 <= t0:
                raise click.ClickException(f"{ticker} has no usable trading window between {d0} and {d1}")
            inv_total = tp1 / tp0 - 1
            inv_years = (t1 - t0).days / 365.25
            heading = ticker if (t0, t1) == (d0, d1) else f"{ticker}  [dim]{t0} → {t1}[/dim]"
        inv_ann = (1 + inv_total) ** (1 / inv_years) - 1
        table.add_section()
        table.add_row(f"[bold cyan]{heading}[/bold cyan]", "")
        table.add_row(growth_label, money(principal * (1 + inv_total)))
        table.add_row("Total return", pct(inv_total))
        table.add_row("Annualised", pct(inv_ann, 2) + "/yr")
        table.add_section()
        gap = (inv_ann - sp_ann) * 100
        label, colour = ("Ahead of the S&P 500", "green") if gap >= 0 else ("Behind the S&P 500", "red")
        table.add_row(f"[bold]{label}[/bold]", f"[{colour}]{abs(gap):,.2f} points/yr[/{colour}]")

    console.print(table)


def interactive() -> None:
    """Prompt for action/ticker/quantity/price."""
    action = Prompt.ask("Action", choices=["buy", "sell"], default="buy").upper()
    ticker = Prompt.ask("Ticker").strip().upper()
    if not ticker:
        raise click.ClickException("ticker required")
    qty = _validate_quantity(Prompt.ask("Quantity"))
    execute(action, ticker, qty, None)


if __name__ == "__main__":
    cli()
