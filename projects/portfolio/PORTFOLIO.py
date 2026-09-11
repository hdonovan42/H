#!/usr/bin/env python3
"""PORTFOLIO.py — stock portfolio tracker. Data lives in ~/.portfolio-vault/."""
from __future__ import annotations

import bisect
import calendar
import io
import json
import os
import re
import subprocess
import sys
import zipfile
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


# ─── risk-free (US T-bills) ───────────────────────────────────────────────────

CACHE_DIR = Path.home() / ".cache" / "portfolio"
RF_CACHE_FILE = CACHE_DIR / "riskfree.json"
RF_CACHE_TTL_DAYS = 7
RF_FLOOR = date(1926, 7, 1)  # start of the Ken French RF series
FRENCH_ZIP_URL = (
    "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
    "F-F_Research_Data_Factors_CSV.zip"
)
FRED_DTB3_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3"


def _parse_french_monthly(csv_text: str) -> dict[str, float]:
    """Monthly 1-month T-bill returns in percent: {'1926-07': 0.22, ...}.

    Monthly rows have a 6-digit YYYYMM key; the annual section (4-digit keys)
    and prose header/footer lines are skipped by the same test.
    """
    monthly: dict[str, float] = {}
    for line in csv_text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 5 and len(parts[0]) == 6 and parts[0].isdigit():
            rf = float(parts[4])
            if rf > -99:  # French files use -99.99 for missing
                monthly[f"{parts[0][:4]}-{parts[0][4:]}"] = rf
    return monthly


def _fetch_rf_remote() -> dict:
    r = requests.get(FRENCH_ZIP_URL, timeout=30)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        csv_text = zf.read(zf.namelist()[0]).decode("utf-8", errors="replace")
    monthly = _parse_french_monthly(csv_text)
    if not monthly:
        raise ValueError("no monthly rows parsed from the Ken French file")
    r = requests.get(FRED_DTB3_URL, timeout=30)
    r.raise_for_status()
    # Daily 3-month bill yields cover the months the French series hasn't
    # published yet (~2-month lag). Kept from the start of the last French
    # month so a carry-forward seed observation always exists.
    cutoff = f"{max(monthly)}-01"
    daily: list[list] = []
    for line in r.text.splitlines()[1:]:
        day, _, value = line.strip().partition(",")
        if day >= cutoff and value not in ("", "."):
            daily.append([day, float(value)])
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "monthly": monthly,
        "daily": daily,
    }


def load_rf_data(refresh: bool = False) -> dict:
    cached: Optional[dict] = None
    if RF_CACHE_FILE.exists():
        try:
            cached = json.loads(RF_CACHE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            cached = None
    if cached and not refresh:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"])
        if age < timedelta(days=RF_CACHE_TTL_DAYS):
            return cached
    try:
        data = _fetch_rf_remote()
    except (requests.RequestException, zipfile.BadZipFile, ValueError) as e:
        if cached:
            console.print(
                f"[yellow]⚠ rate download failed ({e}); "
                f"using cached data from {cached['fetched_at'][:10]}[/yellow]"
            )
            return cached
        raise click.ClickException(f"cannot download risk-free rate data: {e}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RF_CACHE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data) + "\n")
    os.replace(tmp, RF_CACHE_FILE)
    return data


def _next_month(d: date) -> date:
    return date(d.year + d.month // 12, d.month % 12 + 1, 1)


def rf_growth(data: dict, start: date, end: date) -> tuple[float, int]:
    """Compound T-bill growth factor over [start, end).

    Whole months inside the French series multiply exactly; partial months are
    pro-rated as (1+rf)^(days/days_in_month). Months past the French series
    compound FRED daily yields (y/365 per day), carrying the last observation
    across weekends and holidays. Returns (factor, days_estimated) where
    days_estimated counts days past the last published daily yield.
    """
    monthly = data["monthly"]
    daily = data["daily"]
    daily_yield = dict(daily)
    daily_dates = [day for day, _ in daily]
    last_published = daily_dates[-1] if daily_dates else ""
    i = bisect.bisect_right(daily_dates, start.isoformat()) - 1
    carried = daily[i][1] if i >= 0 else None
    factor = 1.0
    estimated_days = 0
    d = start
    while d < end:
        rf = monthly.get(f"{d.year:04d}-{d.month:02d}")
        if rf is not None:
            month_end = _next_month(d)
            if d.day == 1 and month_end <= end:
                factor *= 1 + rf / 100
                d = month_end
                continue
            days_in_month = calendar.monthrange(d.year, d.month)[1]
            factor *= (1 + rf / 100) ** (1 / days_in_month)
        else:
            iso = d.isoformat()
            carried = daily_yield.get(iso, carried)
            if carried is None:
                raise click.ClickException(f"no risk-free data available for {iso}")
            if iso > last_published:
                estimated_days += 1
            factor *= 1 + carried / 100 / 365
        d += timedelta(days=1)
    return factor, estimated_days


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
        portfolio riskfree   US T-bill return since any date (vs a ticker or a %)
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
@click.option("--vs", "vs", default=None, metavar="RETURN|TICKER",
              help="Compare a return (e.g. 412%) or a ticker (e.g. AAPL) against the risk-free return.")
@click.option("--refresh", is_flag=True, help="Force re-download of the rate data.")
def riskfree(start: str, end: Optional[str], amount: Optional[float], vs: Optional[str], refresh: bool) -> None:
    """Risk-free (rolling US T-bill) return from START to END (default: today).

    \b
    Dates may be YYYY, YYYY-MM or YYYY-MM-DD (data starts 1926-07):
        portfolio riskfree 1994-03-15
        portfolio riskfree 1990 2000
        portfolio riskfree 2015 --amount 10000 --vs AAPL
        portfolio riskfree 2015 --vs 412%
    """
    start_d = parse_flex_date(start, "START")
    today = date.today()
    end_d = parse_flex_date(end, "END") if end else today
    if start_d < RF_FLOOR:
        raise click.ClickException(f"risk-free data starts {RF_FLOOR} — earliest supported START")
    if start_d > today:
        raise click.ClickException(f"START cannot be in the future (today is {today})")
    if end_d > today:
        raise click.ClickException(f"END cannot be in the future (today is {today})")
    if end_d <= start_d:
        raise click.ClickException("END must be after START")

    data = load_rf_data(refresh=refresh)
    factor, estimated_days = rf_growth(data, start_d, end_d)
    years = (end_d - start_d).days / 365.25
    rf_ann = factor ** (1 / years) - 1

    principal = amount if amount is not None else 1.0
    growth_label = f"Growth of ${principal:,.2f}".replace(".00", "")

    def money(x: float) -> str:
        return f"${x:,.4f}" if principal == 1.0 else f"${x:,.2f}"

    def pct(x: float, dp: int = 1) -> str:
        return f"{x * 100:+,.{dp}f}%"

    table = Table(
        title=f"Risk-free (rolling US T-bills)  {start_d} → {end_d}  ({years:,.1f}y)",
        title_style="bold",
        show_header=False,
        min_width=60,
    )
    table.add_column(style="white")
    table.add_column(justify="right", style="bold")
    table.add_row(growth_label, money(principal * factor))
    table.add_row("Total return", pct(factor - 1))
    table.add_row("Annualised", pct(rf_ann, 2) + "/yr")

    notes = ["Ken French 1-mo T-bill returns + FRED 3-mo bill yields"]
    if estimated_days:
        notes.append(f"last {estimated_days}d estimated at the latest published yield")

    if vs:
        if re.fullmatch(r"[+-]?\d+(?:\.\d+)?\s*%?", vs.strip()):
            inv_total = float(vs.strip().rstrip("%").strip()) / 100
            inv_years = years
            heading = f"Supplied return ({vs.strip()})"
        else:
            ticker = vs.strip().upper()
            d0, px0 = fetch_adjclose_near(ticker, start_d)
            d1, px1 = fetch_adjclose_near(ticker, end_d)
            if d1 <= d0:
                raise click.ClickException(f"{ticker} has no usable trading window between {start_d} and {end_d}")
            inv_total = px1 / px0 - 1
            inv_years = (d1 - d0).days / 365.25
            heading = f"{ticker}  [dim]adj. close {d0} → {d1}[/dim]"
            notes.append(f"{ticker} uses Yahoo adjusted closes (splits + dividends)")
        inv_ann = (1 + inv_total) ** (1 / inv_years) - 1
        table.add_section()
        table.add_row(f"[bold cyan]{heading}[/bold cyan]", "")
        table.add_row(growth_label, money(principal * (1 + inv_total)))
        table.add_row("Total return", pct(inv_total))
        table.add_row("Annualised", pct(inv_ann, 2) + "/yr")
        table.add_section()
        excess = (inv_ann - rf_ann) * 100
        colour = "green" if excess >= 0 else "red"
        table.add_row("[bold]Excess vs risk-free[/bold]", f"[{colour}]{excess:+,.2f} pp/yr[/{colour}]")

    table.caption = " · ".join(notes)
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
