#!/usr/bin/env python3
"""PORTFOLIO.py — stock portfolio tracker. Data lives in ~/.portfolio-vault/."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
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
        r = requests.get(f"{WORKER_BASE}/yahoo-quote/{ticker}", timeout=5)
        if r.ok:
            data = r.json()
            result = data.get("quoteResponse", {}).get("result") or data.get("result") or []
            if result:
                price = (
                    result[0].get("regularMarketPrice")
                    or result[0].get("postMarketPrice")
                    or result[0].get("preMarketPrice")
                )
                if price:
                    return float(price)
    except (requests.RequestException, ValueError):
        pass
    return None


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
    total = 0.0
    any_missing = False
    if not positions:
        table.add_row("—", "—", "—", "—")
    else:
        for ticker in sorted(positions):
            qty = positions[ticker]
            price = fetch_price(ticker)
            if price is None:
                any_missing = True
                table.add_row(ticker, str(qty), "—", "—")
            else:
                value = price * qty
                total += value
                table.add_row(ticker, str(qty), f"{price:,.2f}", f"{value:,.2f}")
        table.add_section()
        table.add_row("TOTAL", "", "", f"{total:,.2f}")
    if any_missing:
        table.caption = "[yellow]some prices unavailable — total excludes them[/yellow]"
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

@click.group(invoke_without_command=True)
@click.pass_context
def cli(ctx: click.Context) -> None:
    """PORTFOLIO — command-line stock portfolio tracker.

    \b
    Every buy and sell records a price. Give it explicitly with `@`:
        portfolio buy AAPL 10 @ 401.00
        portfolio sell AAPL 4 @ 415.50

    \b
    Omit the price and you'll be asked to either use the current market
    price (shown as a preview) or type your own:
        portfolio buy AAPL 10
        -> No price given. [1] at current price ($401.23)  [2] enter price

    \b
    Other commands:
        portfolio value      current holdings, live prices + total value
        portfolio history    full transaction ledger (with recorded prices)
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
    """Show current portfolio with live prices and total value."""
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
