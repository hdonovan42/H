"""Main sleep/wake loop, PID file, signal handling, death handling."""

import os
import signal
import sys
import time
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path
from vault.config_loader import load_config, get_pid_path
from vault.db import init_db, get_meta, set_meta
from vault.agent import run_cycle
from vault.guardrails import check_death, is_alive
from vault import ledger

log = logging.getLogger("vault.daemon")

_shutdown_requested = False


def _orphan_sweep(conn, cfg) -> dict:
    """Resolve stuck 'pending' and 'reconciling' predictions against on-chain state.

    For each: compare DB's clob_token_id against on-chain CTF balance.
      - pending ≥ timeout + shares on-chain → confirm (using cost_basis as debit)
      - pending ≥ timeout + no on-chain shares → cancel (USDC never moved)
      - reconciling + shares on-chain → confirm
      - reconciling + no on-chain shares → cancel

    Pending rows younger than the timeout are left alone (CLOB may still be in flight).
    Returns a summary dict for logging.
    """
    from vault.clob_client import get_ctf_balance, get_usdc_balance
    import datetime as dt

    clob_cfg = cfg.get("trading", {}).get("clob", {})
    timeout_sec = clob_cfg.get("pending_timeout_seconds", 300)

    pending = ledger.get_pending_predictions(conn)
    reconciling = conn.execute(
        "SELECT id, market_id, question, side, shares, entry_odds, cost_basis, clob_token_id, pending_since "
        "FROM predictions WHERE status = 'reconciling' AND execution_mode = 'real' ORDER BY id ASC"
    ).fetchall()
    reconciling = [dict(r) for r in reconciling]

    confirmed = 0
    cancelled = 0
    skipped = 0
    manual = 0
    now = dt.datetime.now(dt.timezone.utc)

    for pred in pending + reconciling:
        # For pending rows, respect the timeout — CLOB might still be working
        if pred in pending and pred.get("pending_since"):
            try:
                since = dt.datetime.fromisoformat(pred["pending_since"].replace("Z", "+00:00"))
                age = (now - since).total_seconds()
                if age < timeout_sec:
                    skipped += 1
                    continue
            except Exception:
                pass  # unparseable timestamp → treat as old, reconcile

        token_id = pred.get("clob_token_id")
        if not token_id:
            log.warning(f"Pred #{pred['id']} has no clob_token_id; cannot reconcile — leaving in status")
            manual += 1
            continue

        ctf_shares = get_ctf_balance(token_id)
        if ctf_shares is None:
            log.warning(f"Orphan sweep: RPC unavailable for token {str(token_id)[:12]} (pred #{pred['id']}) — will retry")
            skipped += 1
            continue

        expected_shares = pred["shares"]
        if ctf_shares >= expected_shares * 0.99:
            # On-chain has (at least) the shares we expected. Confirm the bet.
            try:
                ledger.record_prediction_confirm(
                    conn, pred["id"],
                    fill_amount_usd=pred["cost_basis"],
                    fill_shares=expected_shares,
                    fill_odds=pred["entry_odds"],
                    fill_verified=True,
                )
                confirmed += 1
                log.info(
                    f"Orphan sweep: confirmed pred #{pred['id']} "
                    f"({expected_shares:.2f} shares @ {pred['entry_odds']:.0%})"
                )
            except ValueError as e:
                # Already transitioned out of pending — race with cycle
                log.debug(f"Pred #{pred['id']} already confirmed: {e}")
                skipped += 1
        elif ctf_shares < 0.01:
            # No shares on-chain; USDC clearly didn't move. Safe to cancel.
            try:
                ledger.record_prediction_cancel(
                    conn, pred["id"],
                    f"Orphan sweep: no on-chain shares (CTF={ctf_shares:.4f}) after timeout"
                )
                cancelled += 1
            except ValueError:
                # Was in reconciling, not pending — just clean up
                conn.execute(
                    "UPDATE predictions SET status = 'cancelled', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), "
                    "resolution = 'cancelled', payout = 0, pnl = 0 WHERE id = ?",
                    (pred["id"],),
                )
                conn.commit()
                cancelled += 1
        else:
            # Ambiguous: some shares on-chain but less than expected (partial fill? extra position?)
            # Refuse to auto-reconcile; flag for manual review and pause the daemon.
            log.critical(
                f"Pred #{pred['id']}: partial on-chain match (expected {expected_shares:.4f}, "
                f"got {ctf_shares:.4f}). Cannot auto-reconcile. Pausing daemon."
            )
            set_meta(conn, "paused", "true")
            conn.execute(
                "INSERT INTO events (event, detail) VALUES (?, ?)",
                ("orphan_manual", f"Pred #{pred['id']}: partial match {ctf_shares:.4f}/{expected_shares:.4f}"),
            )
            conn.commit()
            manual += 1

    return {"confirmed": confirmed, "cancelled": cancelled, "skipped": skipped, "manual": manual}


def _auto_swap_native_usdc(conn, cfg) -> bool:
    """If native USDC is sitting in the wallet (from a Coinbase-style deposit),
    swap it to USDC.e so Polymarket can use it. No-op if nothing to swap.

    Returns True if a swap was performed. Safe to call every reconcile cycle —
    the balance check is cheap, and a swap only fires above the min threshold.
    """
    clob_cfg = cfg.get("trading", {}).get("clob", {})
    if not clob_cfg.get("auto_swap_native_usdc", True):
        return False

    from vault.clob_client import get_native_usdc_balance, swap_native_to_bridged_usdc

    native_bal = get_native_usdc_balance()
    if native_bal is None:
        log.debug("Auto-swap: native USDC balance unavailable (RPC)")
        return False

    min_swap = clob_cfg.get("min_native_swap_usd", 1.00)
    if native_bal < min_swap:
        return False

    slippage_bps = clob_cfg.get("native_swap_slippage_bps", 50)
    log.info(f"Auto-swap: native USDC ${native_bal:.4f} >= ${min_swap:.2f} threshold; swapping")

    result = swap_native_to_bridged_usdc(native_bal, slippage_bps=slippage_bps)
    if result.get("success"):
        detail = (
            f"Swapped ${result['amount_in']:.4f} native USDC -> ${result['amount_out']:.4f} USDC.e "
            f"(tx {result['tx_hash'][:10]}, gas {result.get('gas_cost_matic', 0):.6f} MATIC)"
        )
        log.info(f"Auto-swap OK: {detail}")
        conn.execute(
            "INSERT INTO events (event, detail) VALUES (?, ?)",
            ("auto_swap", detail),
        )
        conn.commit()
        return True
    else:
        log.error(f"Auto-swap FAILED: {result.get('error')}")
        conn.execute(
            "INSERT INTO events (event, detail) VALUES (?, ?)",
            ("auto_swap_failed", f"${native_bal:.4f} stuck as native USDC — {result.get('error', 'unknown')}"),
        )
        conn.commit()
        return False


def _reconcile_balance(conn, cfg):
    """Check on-chain USDC vs expected from DB. Auto-record deposits.

    Before reconciling USDC.e, auto-swap any native USDC sitting in the wallet
    (Coinbase deposits arrive as native; Polymarket needs USDC.e). The swap
    debits native USDC and credits USDC.e, which the subsequent drift check
    then records as a deposit.
    """
    from vault.clob_client import get_usdc_balance

    # Step 1: convert any native USDC to USDC.e (blocking, on-chain)
    _auto_swap_native_usdc(conn, cfg)

    # Step 2: detect external deposits/withdrawals via Transfer-event scan
    try:
        from vault.wallet_sync import sync_wallet_transactions
        summary = sync_wallet_transactions(conn)
        if summary.get("deposits") or summary.get("withdrawals"):
            log.info(f"Wallet sync: {summary}")
    except Exception as e:
        log.error(f"Wallet sync failed: {e}", exc_info=True)

    # Step 3: regular USDC.e drift reconciliation (catches anything the sync missed)
    actual = get_usdc_balance()
    if actual is None:
        log.warning("Balance reconciliation skipped — RPC call failed")
        return

    expected = ledger.compute_expected_onchain(conn)
    diff = round(actual - expected, 6)
    tolerance = cfg.get("trading", {}).get("clob", {}).get("balance_drift_warn", 0.50)

    if diff > tolerance:
        ledger.record_deposit(conn, diff)
        log.info(f"Deposit detected: ${diff:.2f} (on-chain ${actual:.2f}, expected ${expected:.2f})")
    elif diff < -tolerance:
        log.warning(
            f"Negative balance drift: ${diff:.2f} (on-chain ${actual:.2f}, expected ${expected:.2f}) "
            "— possible withdrawal or settlement lag, not auto-adjusting"
        )
    else:
        log.debug(f"Balance reconciliation OK: drift ${diff:.2f} within tolerance")


def _handle_signal(signum, frame):
    global _shutdown_requested
    name = signal.Signals(signum).name
    log.info(f"Received {name}, shutting down gracefully...")
    _shutdown_requested = True


def write_pid():
    """Write PID file."""
    pid_path = get_pid_path()
    pid_path.write_text(str(os.getpid()))
    log.debug(f"PID {os.getpid()} written to {pid_path}")


def remove_pid():
    """Remove PID file."""
    pid_path = get_pid_path()
    if pid_path.exists():
        pid_path.unlink()


def read_pid() -> int | None:
    """Read PID from file. Returns None if not running."""
    pid_path = get_pid_path()
    if not pid_path.exists():
        return None
    try:
        pid = int(pid_path.read_text().strip())
        # Check if process is actually running
        os.kill(pid, 0)
        return pid
    except (ValueError, ProcessLookupError, PermissionError):
        # Stale PID file
        remove_pid()
        return None


def run_daemon(resurrect: bool = False):
    """Main daemon entry point."""
    global _shutdown_requested
    _shutdown_requested = False

    # Check for existing daemon
    existing_pid = read_pid()
    if existing_pid:
        print(f"VAULT daemon already running (PID {existing_pid})")
        sys.exit(1)

    cfg = load_config()
    interval = cfg["daemon"]["interval_seconds"]

    # Init DB
    conn = init_db()

    # Handle resurrection
    if resurrect:
        from vault.guardrails import resurrect as do_resurrect
        do_resurrect(conn)
        print(f"VAULT resurrected with ${cfg['seed_balance']:.2f}")

    # Check if alive
    if not is_alive(conn):
        print("VAULT is DEAD. Use 'vault start --resurrect' to bring it back.")
        sys.exit(1)

    # Seed balance if first run
    ledger.seed_balance(conn)

    # Verify CLOB client if real trading enabled
    if not cfg.get("trading", {}).get("simulated", True):
        # HARD GATE 1: ledger must have gone through `vault go-live` to reach real mode
        if not ledger.is_live(conn):
            print("ERROR: config has `simulated: false` but the ledger has never been through `vault go-live`.")
            print("This is the safeguard added after the 15 March 2026 incident.")
            print("Either set `simulated: true` or run `vault go-live` first.")
            log.critical("Daemon startup blocked: real mode requested but no go_live event in ledger.")
            sys.exit(1)

        try:
            from vault.clob_client import _get_client, get_usdc_balance
            _get_client()  # init + derive creds
            usdc = get_usdc_balance()
            if usdc is None:
                # HARD GATE 2: must verify on-chain state before accepting real trades
                print("ERROR: CLOB client initialised but on-chain USDC balance unavailable — all RPC providers failed.")
                print("Fix RPC config in `trading.clob.rpc_fallback` and retry.")
                log.critical("Daemon startup blocked: real mode with no on-chain verification.")
                sys.exit(1)
            log.info(f"CLOB client ready. On-chain USDC: ${usdc:.2f}")
            print(f"CLOB client ready. On-chain USDC: ${usdc:.2f}")

            # HARD GATE 3: on-chain matches expected
            expected = ledger.compute_expected_onchain(conn)
            tol = cfg.get("trading", {}).get("clob", {}).get("balance_divergence_tolerance", 0.50)
            drift = round(usdc - expected, 6)
            if drift < -tol:
                print(f"ERROR: on-chain USDC ${usdc:.2f} < expected ${expected:.2f} (drift ${drift:+.2f}, tolerance ${tol:.2f}).")
                print("Ledger and wallet are out of sync. Investigate before resuming.")
                log.critical(f"Daemon startup blocked: negative drift ${drift:+.2f} exceeds tolerance.")
                sys.exit(1)
            log.info(f"Real mode verified: expected ${expected:.2f}, on-chain ${usdc:.2f}, drift ${drift:+.2f}")
        except SystemExit:
            raise
        except Exception as e:
            log.error(f"CLOB client init failed: {e}", exc_info=True)
            print(f"ERROR: CLOB client init failed: {e}")
            print("Set trading.simulated: true in config.yaml or fix CLOB credentials.")
            sys.exit(1)

        # HARD GATE 4: orphan sweep at startup — no stale pending rows surviving a restart
        try:
            reconciled = _orphan_sweep(conn, cfg)
            if reconciled:
                log.info(f"Startup orphan sweep: {reconciled}")
        except Exception as e:
            log.error(f"Startup orphan sweep failed: {e}", exc_info=True)
            print(f"ERROR: orphan sweep failed: {e}")
            sys.exit(1)

        # HARD GATE 5: v2 allowance setup. Idempotent — checks each
        # allowance and only sends a tx when it's missing. Logs when a
        # send happens so unexpected gas spend is visible. Doesn't block
        # startup on failure: trading just won't work, but the divergence
        # safeguard will catch any successful order anyway.
        try:
            from vault.clob_client import setup_v2_allowances
            v2_setup = setup_v2_allowances()
            sent = v2_setup["summary"]["sent"]
            failed = v2_setup["summary"]["failed"]
            if sent > 0 or failed > 0:
                log.info(f"v2 allowance setup: {v2_setup['summary']}")
            if failed > 0:
                log.warning(f"v2 allowance setup had {failed} failures: {v2_setup['actions']}")
        except Exception as e:
            log.error(f"setup_v2_allowances raised at startup: {e}", exc_info=True)

    # Guard 6: Set dry-run counter on startup (real trading only)
    if not cfg.get("trading", {}).get("simulated", True):
        dry_run_cycles = cfg.get("trading", {}).get("clob", {}).get("dry_run_startup_cycles", 5)
        if dry_run_cycles > 0:
            set_meta(conn, "dry_run_remaining", str(dry_run_cycles))
            conn.commit()
            log.info(f"DRY-RUN MODE: first {dry_run_cycles} cycles will log-only (no real orders)")
            print(f"DRY-RUN MODE: first {dry_run_cycles} cycles will log-only (no real orders)")

    # Register signal handlers
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    # Write PID
    write_pid()

    # Log start event
    balance = ledger.get_balance(conn)
    conn.execute(
        "INSERT INTO events (event, detail) VALUES (?, ?)",
        ("start", f"Daemon started. Balance: ${balance:.2f}"),
    )
    conn.commit()

    log.info(f"VAULT daemon started. Balance: ${balance:.2f}. Interval: {interval}s.")
    print(f"VAULT daemon started (PID {os.getpid()}). Balance: ${balance:.2f}")

    try:
        while not _shutdown_requested:
            # Check alive
            if not is_alive(conn) or check_death(conn):
                log.critical("VAULT is dead. Daemon stopping.")
                conn.execute(
                    "INSERT INTO events (event, detail) VALUES (?, ?)",
                    ("death", "Daemon stopped due to death condition."),
                )
                conn.commit()
                break

            # Check pause
            if get_meta(conn, "paused") == "true":
                log.debug("VAULT is paused, skipping cycle.")
                for _ in range(interval):
                    if _shutdown_requested:
                        break
                    time.sleep(1)
                continue

            # Guard 5: Cycle-level balance assertion (real trading only)
            is_simulated = cfg.get("trading", {}).get("simulated", True)
            if not is_simulated:
                from vault.guardrails import check_balance_divergence
                tolerance = cfg.get("trading", {}).get("clob", {}).get("balance_divergence_tolerance", 1.0)
                try:
                    diverged, detail = check_balance_divergence(conn, tolerance)
                    if diverged:
                        log.critical(f"BALANCE DIVERGENCE: {detail}")
                        for _ in range(interval):
                            if _shutdown_requested:
                                break
                            time.sleep(1)
                        continue
                except Exception as e:
                    log.warning(f"Balance divergence check failed: {e}")

            # Run cycle with timeout (shared connection with check_same_thread=False)
            try:
                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(run_cycle, conn)
                    result = future.result(timeout=300)
                if result.get("action") == "death":
                    log.critical("Agent died during cycle.")
                    break
            except TimeoutError:
                log.error("Cycle timed out after 300s")
                conn.execute(
                    "INSERT INTO events (event, detail) VALUES (?, ?)",
                    ("error", "Cycle timed out after 300s"),
                )
                conn.commit()
            except Exception as e:
                log.error(f"Cycle error: {e}", exc_info=True)
                conn.execute(
                    "INSERT INTO events (event, detail) VALUES (?, ?)",
                    ("error", f"Cycle error: {str(e)[:500]}"),
                )
                conn.commit()

            # Balance reconciliation + orphan sweep (real trading only)
            is_simulated = cfg.get("trading", {}).get("simulated", True)
            if not is_simulated:
                cycle_count = conn.execute("SELECT COUNT(*) as c FROM cycles").fetchone()["c"]
                clob_cfg = cfg.get("trading", {}).get("clob", {})
                reconcile_interval = clob_cfg.get("reconcile_interval_cycles", 10)
                orphan_interval = clob_cfg.get("orphan_sweep_interval_cycles", 30)

                if cycle_count % reconcile_interval == 0:
                    try:
                        _reconcile_balance(conn, cfg)
                    except Exception as e:
                        log.warning(f"Balance reconciliation failed: {e}")

                # Orphan sweep: run every N cycles OR whenever a pending prediction exists
                # (pending = highest-priority state; don't wait for the timer)
                needs_sweep = (
                    cycle_count % orphan_interval == 0
                    or ledger.has_pending_predictions(conn)
                )
                if needs_sweep:
                    try:
                        summary = _orphan_sweep(conn, cfg)
                        if summary.get("confirmed") or summary.get("cancelled") or summary.get("manual"):
                            log.info(f"Orphan sweep: {summary}")
                    except Exception as e:
                        log.error(f"Orphan sweep failed: {e}", exc_info=True)

                # Redemption sweep: redeem CTF shares from closed wins that
                # haven't been redeemed yet. Runs alongside the orphan sweep
                # (same interval) — both are reconciliation passes that touch
                # on-chain state, so co-locating keeps cycle-level work bounded.
                if cycle_count % orphan_interval == 0:
                    try:
                        from vault.redeem import redemption_sweep
                        rsummary = redemption_sweep(conn)
                        if rsummary.get("redeemed") or rsummary.get("failed"):
                            log.info(f"Redemption sweep: {rsummary}")
                    except Exception as e:
                        log.error(f"Redemption sweep failed: {e}", exc_info=True)

            # Sleep in 1-second increments (responsive to signals)
            for _ in range(interval):
                if _shutdown_requested:
                    break
                time.sleep(1)

    finally:
        # Cleanup
        remove_pid()
        balance = ledger.get_balance(conn)
        conn.execute(
            "INSERT INTO events (event, detail) VALUES (?, ?)",
            ("stop", f"Daemon stopped. Balance: ${balance:.2f}"),
        )
        conn.commit()
        conn.close()
        log.info("VAULT daemon stopped.")
