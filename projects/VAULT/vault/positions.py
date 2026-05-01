"""On-chain authoritative share count for real-mode positions.

Until this module landed, `predictions.shares` was written once at confirm
time (from a CTF balanceOf read inside the v20.1 stealth-fill detection)
and trusted forever. The 1 May 2026 pred #12 incident showed this is
unsafe: the v20.1 read returned 5.076859 shares, the actual on-chain
balance was 0.006859 (likely the v20.1 read caught a transient mid-
settlement state), and we carried the phantom 5.07 in the DB for 3 days
before noticing because no one re-checked.

The fix: at the start of every cycle, re-read the on-chain CTF balance
for every open real-mode prediction. If the DB says 5.08 and the chain
says 0.006859, the chain wins, the DB updates to match, and a
share_correction ledger entry records the realized loss/gain so the
audit log shows it.

Sim-mode predictions are untouched — they have no on-chain counterpart.
"""
from __future__ import annotations

import logging

from vault.clob_client import get_ctf_balance

log = logging.getLogger("vault.positions")

# How big a divergence triggers a ledger correction entry. Below this
# we silently update predictions.shares to match (small rounding-style
# drift from settlement timing or fee adjustments). Above this we log
# CRITICAL and write a share_correction ledger entry so the audit log
# captures the cost.
SHARE_CORRECTION_THRESHOLD = 0.01


def reconcile_real_mode_shares(conn) -> dict:
    """Sync `predictions.shares` to on-chain CTF balance for every open
    real-mode position. Called at the start of each cycle.

    Returns a summary dict for cycle-level logging.
    """
    open_real = conn.execute(
        "SELECT id, market_id, side, clob_token_id, shares, cost_basis, "
        "entry_odds, question "
        "FROM predictions "
        "WHERE status = 'open' AND execution_mode = 'real' AND clob_token_id IS NOT NULL"
    ).fetchall()

    if not open_real:
        return {"checked": 0, "updated": 0, "blind": 0, "corrections": 0}

    checked = 0
    updated = 0
    blind = 0
    corrections = 0

    for pred in open_real:
        checked += 1
        token_id = pred["clob_token_id"]
        db_shares = float(pred["shares"] or 0)

        onchain = get_ctf_balance(token_id)
        if onchain is None:
            # RPC blind. Don't touch the DB — better to keep stale data than
            # corrupt it. This is the only acceptable case where DB and
            # on-chain may disagree post-cycle.
            blind += 1
            log.warning(
                f"reconcile: pred #{pred['id']} on-chain CTF read failed "
                f"(token {str(token_id)[:12]}); leaving DB shares={db_shares:.6f} unchanged"
            )
            continue

        diff = onchain - db_shares
        if abs(diff) <= 0.000001:
            continue  # exact match — no work

        if abs(diff) > SHARE_CORRECTION_THRESHOLD:
            # Significant divergence: write an audit-trail ledger entry.
            # Compute the dollar value of the missing/extra shares at the
            # entry odds (best estimate available without a live mid-quote).
            corrections += 1
            est_value_lost = round(abs(diff) * float(pred["entry_odds"] or 0), 6)
            sign = "+" if diff > 0 else "-"
            log.critical(
                f"SHARE CORRECTION pred #{pred['id']} '{pred['question'][:40]}': "
                f"DB={db_shares:.6f} vs on-chain={onchain:.6f} "
                f"({sign}{abs(diff):.6f} shares ≈ ${est_value_lost:.4f} at {pred['entry_odds']:.0%})"
            )
            try:
                last_balance = conn.execute(
                    "SELECT balance_after FROM ledger ORDER BY id DESC LIMIT 1"
                ).fetchone()
                last_balance = last_balance[0] if last_balance else 0.0
                conn.execute(
                    "INSERT INTO ledger (entry_type, amount, description, "
                    "reference_id, balance_after) VALUES (?, ?, ?, ?, ?)",
                    (
                        "share_correction",
                        0.0,  # no cash change — only the share record diverged
                        f"Pred #{pred['id']}: on-chain shares {onchain:.6f} "
                        f"(was {db_shares:.6f}, diff {sign}{abs(diff):.6f}). "
                        f"DB updated to match on-chain truth.",
                        pred["id"],
                        last_balance,
                    ),
                )
            except Exception as e:
                log.error(f"failed to write share_correction ledger entry for #{pred['id']}: {e}")

        # Update the DB to match on-chain. The chain is authoritative.
        try:
            conn.execute(
                "UPDATE predictions SET shares = ? WHERE id = ?",
                (round(onchain, 6), pred["id"]),
            )
            conn.commit()
            updated += 1
        except Exception as e:
            log.error(f"failed to UPDATE pred #{pred['id']} shares: {e}")

    return {
        "checked": checked,
        "updated": updated,
        "blind": blind,
        "corrections": corrections,
    }
