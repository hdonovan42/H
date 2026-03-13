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
        try:
            from vault.clob_client import _get_client, get_usdc_balance
            _get_client()  # init + derive creds
            usdc = get_usdc_balance()
            log.info(f"CLOB client ready. On-chain USDC: ${usdc:.2f}")
            print(f"CLOB client ready. On-chain USDC: ${usdc:.2f}")
        except Exception as e:
            log.error(f"CLOB client init failed: {e}", exc_info=True)
            print(f"ERROR: CLOB client init failed: {e}")
            print("Set trading.simulated: true in config.yaml or fix CLOB credentials.")
            sys.exit(1)

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
