"""Click-based CLI — the operator interface to VAULT."""

import os
import signal
import sys
import logging
import click

from vault.config_loader import load_config, get_pid_path
from vault.db import init_db, get_meta, set_meta
from vault.daemon import read_pid


def _setup_logging(verbose: bool = False):
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )


@click.group()
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging")
def cli(verbose):
    """VAULT — Variable Autonomous Utility & Ledger Testbed"""
    _setup_logging(verbose)


@cli.command()
@click.option("--resurrect", is_flag=True, help="Resurrect from death with fresh $50 seed")
@click.option("--foreground", "-f", is_flag=True, help="Run in foreground (don't daemonize)")
def start(resurrect, foreground):
    """Start the VAULT daemon."""
    from vault.daemon import run_daemon
    run_daemon(resurrect=resurrect)


@cli.command()
def stop():
    """Gracefully stop the VAULT daemon."""
    pid = read_pid()
    if not pid:
        click.echo("VAULT daemon is not running.")
        return
    os.kill(pid, signal.SIGTERM)
    click.echo(f"Sent SIGTERM to VAULT daemon (PID {pid}).")


@cli.command()
def kill():
    """Immediately kill the VAULT daemon."""
    pid = read_pid()
    if not pid:
        click.echo("VAULT daemon is not running.")
        return
    os.kill(pid, signal.SIGKILL)
    # Clean up PID file
    pid_path = get_pid_path()
    if pid_path.exists():
        pid_path.unlink()
    click.echo(f"Sent SIGKILL to VAULT daemon (PID {pid}).")


@cli.command()
def status():
    """Show VAULT status — balance, burn rate, runway, positions."""
    from vault.reporting import status_report
    conn = init_db()
    click.echo(status_report(conn))
    conn.close()


@cli.command()
@click.option("--limit", "-n", default=20, help="Number of cycles to show")
def logs(limit):
    """Show recent cycle logs with reasoning."""
    from vault.reporting import logs_report
    conn = init_db()
    click.echo(logs_report(conn, limit))
    conn.close()


@cli.command()
def report():
    """Full P&L report with cost breakdown and survival metrics."""
    from vault.reporting import full_report
    conn = init_db()
    click.echo(full_report(conn))
    conn.close()


@cli.command()
def history():
    """Show agent's strategy memories."""
    from vault.memory import get_memories
    conn = init_db()
    memories = get_memories(conn, limit=50)
    conn.close()

    if not memories:
        click.echo("No strategy memories recorded yet.")
        return

    click.echo("Agent Strategy Memories:")
    for m in memories:
        click.echo(f"  [{m['id']}] ({m['category']}, rel={m['relevance']:.1f}) {m['content']}")
        click.echo(f"       recorded: {m['ts'][:16]}")


@cli.command()
def pause():
    """Pause the daemon (still alive, just sleeping)."""
    conn = init_db()
    set_meta(conn, "paused", "true")
    conn.execute(
        "INSERT INTO events (event, detail) VALUES (?, ?)",
        ("pause", "Operator paused VAULT"),
    )
    conn.commit()
    conn.close()
    click.echo("VAULT paused. Use 'vault resume' to continue.")


@cli.command()
def resume():
    """Resume from pause."""
    conn = init_db()
    set_meta(conn, "paused", "false")
    conn.execute(
        "INSERT INTO events (event, detail) VALUES (?, ?)",
        ("resume", "Operator resumed VAULT"),
    )
    conn.commit()
    conn.close()
    click.echo("VAULT resumed.")


@cli.command("seed-intel")
@click.argument("filepath", type=click.Path(exists=True))
def seed_intel(filepath):
    """Seed the master intelligence document from a file."""
    from vault.intelligence import seed_intelligence

    with open(filepath, "r") as f:
        text = f.read().strip()

    # Check for THEMES_JSON line
    themes_json = None
    if "THEMES_JSON:" in text:
        parts = text.split("THEMES_JSON:")
        document = parts[0].strip()
        try:
            import json
            themes_json = json.dumps(json.loads(parts[1].strip()))
        except (json.JSONDecodeError, IndexError):
            document = text
            click.echo("Warning: Could not parse THEMES_JSON line — storing document only.")
    else:
        document = text

    conn = init_db()
    seed_intelligence(conn, document, themes_json)
    conn.close()

    click.echo(f"Seeded master intelligence document ({len(document)} chars)")
    if themes_json:
        import json
        themes = json.loads(themes_json)
        click.echo(f"  with {len(themes)} themes")


@cli.command()
@click.option("--host", default="0.0.0.0", help="API host")
@click.option("--port", "-p", default=3200, help="API port")
def api(host, port):
    """Start the VAULT dashboard API server."""
    from vault.api import run_api
    run_api(host=host, port=port)


@cli.command()
def shadow():
    """Show shadow pyramid trade performance by variant."""
    conn = init_db()
    try:
        variants = conn.execute(
            "SELECT variant, "
            "COUNT(*) as total, "
            "SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved, "
            "SUM(CASE WHEN resolved = 1 AND shadow_pnl > 0 THEN 1 ELSE 0 END) as wins, "
            "SUM(CASE WHEN resolved = 1 AND shadow_pnl <= 0 THEN 1 ELSE 0 END) as losses, "
            "COALESCE(SUM(shadow_pnl), 0) as total_pnl, "
            "COALESCE(AVG(cost_basis), 0) as avg_size, "
            "COALESCE(AVG(unrealised_roi), 0) as avg_roi_at_entry "
            "FROM shadow_trades GROUP BY variant ORDER BY variant"
        ).fetchall()

        if not variants:
            click.echo("No shadow trades recorded yet. Waiting for pyramid signals...")
            return

        click.echo("\nShadow Pyramid Trades\n")
        for v in variants:
            resolved = v["resolved"]
            win_rate = (v["wins"] / resolved * 100) if resolved > 0 else 0
            click.echo(f"  {v['variant'].upper()}")
            click.echo(f"    Trades:     {v['total']} ({resolved} resolved)")
            click.echo(f"    Shadow P&L: ${v['total_pnl']:+.2f}")
            click.echo(f"    Win rate:   {win_rate:.1f}%")
            click.echo(f"    Avg size:   ${v['avg_size']:.2f}")
            click.echo(f"    Avg ROI:    {v['avg_roi_at_entry']:.1%} at entry")
            click.echo()
    finally:
        conn.close()


@cli.command()
@click.option("--days", "-d", default=None, type=int, help="Lookback period in days (default: all history)")
def backtest(days):
    """Run safeguard backtester against trade history."""
    from vault.backtester import run_backtest, format_results
    conn = init_db()
    try:
        results = run_backtest(conn, lookback_days=days)
        click.echo(format_results(results))
    finally:
        conn.close()


@cli.command("setup-clob")
def setup_clob():
    """One-time setup: approve USDC + CTF token allowances for Polymarket CLOB."""
    from vault.config_loader import load_config
    load_config()  # ensure .env is loaded

    click.echo("Initialising CLOB client...")
    try:
        from vault.clob_client import _get_client, check_allowances, setup_allowances, get_usdc_balance

        _get_client()
        click.echo("CLOB client connected.")

        # Check current state
        usdc = get_usdc_balance()
        click.echo(f"On-chain USDC balance: ${usdc:.2f}")

        allowance_info = check_allowances()
        click.echo(f"Current allowance: ${allowance_info.get('allowance', 0):.2f}")

        if allowance_info.get("error"):
            click.echo(f"Warning: {allowance_info['error']}")

        # Set allowances
        click.echo("\nApproving exchange contracts...")
        result = setup_allowances()
        if result.get("success"):
            click.echo("Allowances approved successfully.")
        else:
            click.echo(f"Allowance setup failed: {result.get('error')}")
            sys.exit(1)

        # Verify
        new_allowance = check_allowances()
        click.echo(f"\nVerified allowance: ${new_allowance.get('allowance', 0):.2f}")
        click.echo(f"USDC balance: ${usdc:.2f}")
        click.echo("\nCLOB setup complete. You can now set trading.simulated: false in config.yaml.")

    except Exception as e:
        click.echo(f"Setup failed: {e}")
        sys.exit(1)


@cli.command()
@click.argument("key", required=False)
@click.argument("value", required=False)
def config(key, value):
    """Show or set configuration."""
    import yaml
    cfg = load_config()

    if key is None:
        click.echo(yaml.dump(cfg, default_flow_style=False))
    elif value is None:
        # Navigate to key
        parts = key.split(".")
        node = cfg
        for part in parts:
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                click.echo(f"Key not found: {key}")
                return
        if isinstance(node, dict):
            click.echo(yaml.dump(node, default_flow_style=False))
        else:
            click.echo(f"{key} = {node}")
    else:
        click.echo("Config modification not yet supported via CLI. Edit config.yaml directly.")
