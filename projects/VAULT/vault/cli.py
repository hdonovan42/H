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


@cli.command("verify-live")
def verify_live():
    """Pre-flight: check every gate needed to safely enter real-money trading.

    Exits 0 only if ALL gates pass. Exit 1 on any failure. This is the last line of
    defence before `vault go-live` and `simulated: false`.
    """
    from vault.config_loader import load_config
    from vault import ledger as _ledger
    cfg = load_config()
    conn = init_db()

    checks = []  # list of (ok: bool, label: str, detail: str)

    # 1. CLOB client init + derive creds
    try:
        from vault.clob_client import _get_client, get_usdc_balance, check_allowances
        _get_client()
        checks.append((True, "CLOB client init", "creds derived"))
    except Exception as e:
        checks.append((False, "CLOB client init", str(e)))

    # 2. On-chain USDC balance via RPC fallback
    try:
        from vault.clob_client import get_usdc_balance, _get_rpc_urls
        usdc = get_usdc_balance()
        rpc_urls = _get_rpc_urls()
        if usdc is None:
            checks.append((False, "On-chain USDC", f"all {len(rpc_urls)} RPC providers failed"))
        else:
            checks.append((True, "On-chain USDC", f"${usdc:.2f} via {len(rpc_urls)} fallback providers"))
    except Exception as e:
        checks.append((False, "On-chain USDC", str(e)))
        usdc = None

    # 3. Allowances set
    try:
        from vault.clob_client import check_allowances
        al = check_allowances()
        allowance = al.get("allowance", 0)
        if allowance > 0:
            checks.append((True, "Allowances", f"${allowance:.2f} collateral approved"))
        else:
            checks.append((False, "Allowances", "zero or unavailable — run `vault setup-clob`"))
    except Exception as e:
        checks.append((False, "Allowances", str(e)))

    # 4. No leftover open real predictions from a previous life
    stale = conn.execute(
        "SELECT COUNT(*) FROM predictions "
        "WHERE execution_mode = 'real' AND status IN ('pending', 'open', 'reconciling')"
    ).fetchone()[0]
    if stale == 0:
        checks.append((True, "No stale real predictions", "0 pending/open/reconciling rows"))
    else:
        checks.append((False, "No stale real predictions", f"{stale} row(s) need resolution before go-live"))

    # 5. compute_expected_onchain vs on-chain USDC (only meaningful if already live)
    if _ledger.is_live(conn):
        expected = _ledger.compute_expected_onchain(conn)
        if usdc is None:
            checks.append((False, "Ledger vs on-chain", "cannot verify (RPC unavailable)"))
        else:
            drift = round(usdc - expected, 6)
            tol = cfg.get("trading", {}).get("clob", {}).get("balance_divergence_tolerance", 0.50)
            if abs(drift) <= tol:
                checks.append((True, "Ledger vs on-chain", f"drift ${drift:+.2f} within ${tol:.2f} tolerance"))
            else:
                checks.append((False, "Ledger vs on-chain", f"drift ${drift:+.2f} exceeds ${tol:.2f}"))
    else:
        checks.append((True, "Ledger not yet live", "go-live will snap paper balance to on-chain (expected)"))

    # 6. Daemon not currently running
    pid = read_pid()
    if pid is None:
        checks.append((True, "Daemon not running", "safe to modify state"))
    else:
        checks.append((False, "Daemon not running", f"PID {pid} running — stop it first"))

    # 7. RPC fallback list has ≥ 2 entries
    try:
        from vault.clob_client import _get_rpc_urls
        urls = _get_rpc_urls()
        if len(urls) >= 2:
            checks.append((True, "RPC fallback list", f"{len(urls)} providers configured"))
        else:
            checks.append((False, "RPC fallback list", f"only {len(urls)} provider(s) — need ≥ 2"))
    except Exception as e:
        checks.append((False, "RPC fallback list", str(e)))

    # Render result
    click.echo()
    click.echo("VAULT go-live pre-flight checks:")
    click.echo()
    max_label = max(len(c[1]) for c in checks)
    for ok, label, detail in checks:
        mark = "PASS" if ok else "FAIL"
        click.echo(f"  [{mark}] {label:<{max_label}}  {detail}")
    click.echo()

    all_ok = all(c[0] for c in checks)
    if all_ok:
        click.echo("✓ ALL CHECKS PASSED — you may run `vault go-live`.")
        conn.close()
        sys.exit(0)
    else:
        click.echo("✗ ONE OR MORE CHECKS FAILED — do not proceed.")
        conn.close()
        sys.exit(1)


@cli.command("go-live")
@click.option("--yes", is_flag=True, help="Skip interactive confirmation")
def go_live(yes):
    """Zero the paper ledger and seed with on-chain USDC. Required before real trading.

    This command exists to prevent the 15 March 2026 incident: the daemon used to
    inherit the paper-trading balance as if it were real money. Now the transition
    is an explicit, audited step.
    """
    from vault.config_loader import load_config
    from vault import ledger as _ledger
    from vault.clob_client import get_usdc_balance, _get_client
    cfg = load_config()
    conn = init_db()

    # Note: we deliberately do NOT require `simulated: false` here.
    # The recommended deploy flow is: deploy with simulated=true (so the daemon doesn't
    # crash-loop waiting for a go_live event that doesn't exist), then run `vault go-live`
    # while daemon is still in paper mode, THEN flip simulated=false and restart.
    if cfg.get("trading", {}).get("simulated", True):
        click.echo("Note: `simulated: true` in config.yaml. This is the recommended sequence —")
        click.echo("run go-live now, then flip `simulated: false` and restart the daemon.")
        click.echo()

    # Must not already be live — don't silently re-reset an existing real session
    if _ledger.is_live(conn):
        click.echo("WARNING: ledger already contains a `go_live_reset` entry.")
        click.echo("Going live again requires an explicit resurrection. Use `vault start --resurrect` if you want a fresh start.")
        conn.close()
        sys.exit(1)

    # Fetch on-chain balance
    try:
        _get_client()
    except Exception as e:
        click.echo(f"ERROR: CLOB client init failed: {e}")
        conn.close()
        sys.exit(1)

    usdc = get_usdc_balance()
    if usdc is None:
        click.echo("ERROR: on-chain USDC unavailable — all RPC providers failed.")
        click.echo("Fix `trading.clob.rpc_fallback` and retry.")
        conn.close()
        sys.exit(1)

    paper_balance = _ledger.get_balance(conn)
    delta = round(usdc - paper_balance, 6)

    click.echo()
    click.echo(f"  Paper ledger balance:    ${paper_balance:.2f}")
    click.echo(f"  On-chain USDC:           ${usdc:.2f}")
    click.echo(f"  Reset delta:             ${delta:+.2f}")
    click.echo()
    click.echo("This will write a `go_live_reset` entry and mark the ledger as LIVE.")
    click.echo("All subsequent real-mode bets will debit USDC from this new anchor.")

    if not yes:
        if not click.confirm("Proceed?"):
            click.echo("Aborted.")
            conn.close()
            sys.exit(1)

    try:
        _ledger.go_live_reset(conn, usdc)
    except Exception as e:
        click.echo(f"ERROR: go-live failed: {e}")
        conn.close()
        sys.exit(1)

    click.echo(f"✓ VAULT is LIVE. Balance snapped to ${usdc:.2f} on-chain.")
    click.echo("Start the daemon: `vault start`")
    conn.close()


@cli.command("reset-accounting")
@click.option("--yes", is_flag=True, help="Skip interactive confirmation")
def reset_accounting(yes):
    """DESTRUCTIVE: wipe all transactional history, re-seed from current on-chain balance.

    Clears cycles, events, predictions, ledger, api_calls, and all pipeline data.
    Keeps schema + alive flag. Inserts a fresh deposit entry equal to the current
    on-chain USDC.e balance as the starting point for accounting. The wallet sync
    scanner's high-water mark is reset to the current block, so only new transfers
    are tracked.

    USE WITH CARE: backs up nothing. Run `cp vault.db vault.db.bak-$(date +%s)` first.
    """
    from vault.config_loader import load_config
    from vault.wallet_sync import reset_and_seed
    from vault.clob_client import get_usdc_balance, _get_client
    load_config()

    pid = read_pid()
    if pid is not None:
        click.echo(f"ERROR: daemon is running (PID {pid}). Stop it first: `vault stop`.")
        sys.exit(1)

    try:
        _get_client()
    except Exception as e:
        click.echo(f"ERROR: CLOB client init failed: {e}")
        sys.exit(1)

    usdc = get_usdc_balance()
    if usdc is None:
        click.echo("ERROR: on-chain USDC unavailable — all RPC providers failed.")
        sys.exit(1)

    conn = init_db()
    try:
        count_cycles = conn.execute("SELECT COUNT(*) FROM cycles").fetchone()[0]
        count_ledger = conn.execute("SELECT COUNT(*) FROM ledger").fetchone()[0]
        count_predictions = conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]

        click.echo()
        click.echo("Accounting reset:")
        click.echo(f"  Cycles to wipe:       {count_cycles}")
        click.echo(f"  Ledger entries wiped: {count_ledger}")
        click.echo(f"  Predictions wiped:    {count_predictions}")
        click.echo(f"  On-chain USDC.e:      ${usdc:.4f}  (will be the new seed deposit)")
        click.echo()
        click.echo("This is IRREVERSIBLE. Back up vault.db first if you want history preserved.")

        if not yes:
            if not click.confirm("Proceed?"):
                click.echo("Aborted.")
                sys.exit(1)

        seeded = reset_and_seed(conn, seed_amount=usdc)
        click.echo(f"✓ Reset complete. Fresh balance: ${seeded:.4f}. Run `vault start` to resume.")
    finally:
        conn.close()


@cli.command("wallet-sync")
def wallet_sync_cmd():
    """Manually run the wallet transaction sync (picks up any missed deposits/withdrawals)."""
    from vault.wallet_sync import sync_wallet_transactions
    conn = init_db()
    try:
        summary = sync_wallet_transactions(conn)
        click.echo(f"Wallet sync: {summary}")
    finally:
        conn.close()


@cli.command("redeem")
@click.argument("prediction_id", type=int, required=False)
@click.option("--dry-run", is_flag=True, help="Simulate via eth_call only (no broadcast)")
@click.option("--all", "redeem_all", is_flag=True, help="Sweep every redeemable closed real-mode prediction")
def redeem_cmd(prediction_id, dry_run, redeem_all):
    """Redeem on-chain CTF shares for closed real-mode predictions.

    Without args: prints redeemable predictions (read-only).
    With prediction_id: redeem that specific one.
    With --all: sweep every redeemable position.
    """
    from vault.config_loader import load_config
    from vault.redeem import find_redeemable, redeem_prediction, redemption_sweep
    load_config()
    conn = init_db()
    try:
        if redeem_all:
            summary = redemption_sweep(conn)
            click.echo(f"Redemption sweep: {summary}")
            return
        if prediction_id is None:
            redeemable = find_redeemable(conn)
            if not redeemable:
                click.echo("No redeemable positions found.")
                return
            click.echo(f"{len(redeemable)} redeemable position(s):")
            for r in redeemable:
                click.echo(
                    f"  pred #{r['id']} market={r['market_id']} side={r['side']} "
                    f"shares={r['shares']:.4f} expected_payout=${r['expected_payout']:.2f}"
                )
            click.echo("\nRun with a prediction_id to redeem one, or --all to redeem everything.")
            return
        result = redeem_prediction(conn, prediction_id, dry_run=dry_run)
        if result.get("success"):
            if result.get("dry_run"):
                click.echo(f"DRY RUN — would redeem pred #{prediction_id}: {result}")
            else:
                click.echo(
                    f"Redeemed pred #{prediction_id}: "
                    f"+${result.get('usdc_received', 0):.4f} USDC.e "
                    f"(tx {result.get('tx_hash', 'n/a')})"
                )
        else:
            click.echo(f"Failed: {result.get('error')}")
            sys.exit(1)
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
        click.echo(f"On-chain USDC balance: ${usdc:.2f}" if usdc is not None else "On-chain USDC balance: unavailable")

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
