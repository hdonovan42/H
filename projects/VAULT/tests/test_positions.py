"""Tests for on-chain authoritative share reconciliation.

Pinned to the 1 May 2026 pred #12 phantom-shares incident: DB said 5.077
shares, on-chain ERC1155 balance was 0.006859. The cause was v20.1's
confirm-time CTF read catching a transient state. Without reconciliation
the phantom persisted for 3 days, polluting MTM/peak_roi/sell sizing,
and only surfaced when the v2 CLOB API rejected an oversized sell.

reconcile_real_mode_shares re-reads on-chain truth at every cycle start
and updates predictions.shares to match. Significant divergence (>0.01)
writes a share_correction ledger entry for audit.
"""
from unittest.mock import patch

import pytest

from vault import ledger
from vault.positions import reconcile_real_mode_shares, SHARE_CORRECTION_THRESHOLD


def _open_real(conn, *, shares=5.0, cost=1.0, odds=0.20, token="tok_x", market="m1"):
    cur = conn.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, "
        "shares, entry_odds, cost_basis, clob_token_id, status, execution_mode, "
        "opened_at) VALUES (?, ?, ?, ?, 'NO', ?, ?, ?, ?, 'open', 'real', '2026-04-27T00:00:00Z')",
        (market, "0xab", "test?", "test", shares, odds, cost, token),
    )
    conn.commit()
    return cur.lastrowid


def test_no_open_real_predictions_short_circuits(seeded_db):
    ledger.go_live_reset(seeded_db, 50.0)
    summary = reconcile_real_mode_shares(seeded_db)
    assert summary == {"checked": 0, "updated": 0, "blind": 0, "corrections": 0}


def test_exact_match_no_update(seeded_db):
    """When DB matches on-chain exactly, no UPDATE fires and no ledger row."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _open_real(seeded_db, shares=5.076859, token="tok_match")

    with patch("vault.positions.get_ctf_balance", return_value=5.076859):
        summary = reconcile_real_mode_shares(seeded_db)

    assert summary["updated"] == 0
    assert summary["corrections"] == 0
    # No share_correction ledger row written
    rows = seeded_db.execute(
        "SELECT 1 FROM ledger WHERE entry_type = 'share_correction'"
    ).fetchall()
    assert rows == []


def test_pred_12_regression_phantom_shares_corrected(seeded_db):
    """The exact 1 May 2026 scenario: DB says 5.076859, on-chain says 0.006859.
    After reconciliation, DB matches on-chain and a share_correction ledger
    entry records the loss for audit."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _open_real(seeded_db, shares=5.076859, cost=1.029999, odds=0.2029,
                     token="tok_pereira", market="m_lakers")

    with patch("vault.positions.get_ctf_balance", return_value=0.006859):
        summary = reconcile_real_mode_shares(seeded_db)

    assert summary["checked"] == 1
    assert summary["updated"] == 1
    assert summary["corrections"] == 1

    # DB now reflects on-chain truth
    after = seeded_db.execute(
        "SELECT shares FROM predictions WHERE id = ?", (pid,)
    ).fetchone()
    assert after["shares"] == pytest.approx(0.006859)

    # Audit ledger entry written
    correction = seeded_db.execute(
        "SELECT amount, description, reference_id FROM ledger "
        "WHERE entry_type = 'share_correction' AND reference_id = ?", (pid,)
    ).fetchone()
    assert correction is not None
    assert correction["amount"] == 0.0  # no cash change — share count drift only
    assert "5.076859" in correction["description"]
    assert "0.006859" in correction["description"]


def test_small_drift_updates_silently_no_ledger_row(seeded_db):
    """Settlement-rounding-style drift below the threshold still updates
    the DB but doesn't write a noisy ledger entry every cycle."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _open_real(seeded_db, shares=5.076859, token="tok_drift")

    # 0.001 share drift — below threshold, just update silently
    with patch("vault.positions.get_ctf_balance", return_value=5.076859 - 0.001):
        summary = reconcile_real_mode_shares(seeded_db)

    assert summary["updated"] == 1
    assert summary["corrections"] == 0
    # DB updated
    assert seeded_db.execute(
        "SELECT shares FROM predictions WHERE id = ?", (pid,)
    ).fetchone()["shares"] == pytest.approx(5.075859, abs=1e-5)
    # No audit row
    assert seeded_db.execute(
        "SELECT 1 FROM ledger WHERE entry_type = 'share_correction'"
    ).fetchall() == []


def test_rpc_blind_leaves_db_unchanged(seeded_db):
    """If get_ctf_balance returns None (all RPCs failed), keep stale DB data
    rather than corrupting it. The next cycle will retry."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _open_real(seeded_db, shares=5.0, token="tok_blind")

    with patch("vault.positions.get_ctf_balance", return_value=None):
        summary = reconcile_real_mode_shares(seeded_db)

    assert summary["blind"] == 1
    assert summary["updated"] == 0
    assert seeded_db.execute(
        "SELECT shares FROM predictions WHERE id = ?", (pid,)
    ).fetchone()["shares"] == pytest.approx(5.0)


def test_only_open_real_mode_predictions_are_reconciled(seeded_db):
    """Sim mode and closed real-mode rows are skipped. We only touch
    predictions that have on-chain counterparts and that are still alive."""
    ledger.go_live_reset(seeded_db, 50.0)
    # Sim-mode open
    seeded_db.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, "
        "shares, entry_odds, cost_basis, clob_token_id, status, execution_mode) "
        "VALUES ('mA', '0xab', 'q', 's', 'YES', 99, 0.5, 49.5, 'tok_sim', 'open', 'simulated')"
    )
    # Real-mode closed
    seeded_db.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, "
        "shares, entry_odds, cost_basis, clob_token_id, status, execution_mode) "
        "VALUES ('mB', '0xab', 'q', 's', 'YES', 99, 0.5, 49.5, 'tok_done', 'closed', 'real')"
    )
    # Real-mode open — the only one that should be reconciled
    pid = _open_real(seeded_db, shares=5.0, token="tok_target")
    seeded_db.commit()

    calls = []

    def fake_balance(tid):
        calls.append(tid)
        return 1.0

    with patch("vault.positions.get_ctf_balance", side_effect=fake_balance):
        summary = reconcile_real_mode_shares(seeded_db)

    assert summary["checked"] == 1
    assert calls == ["tok_target"]


def test_threshold_constant_documents_floor():
    """The threshold is configurable in code; test pins the expected value
    so accidental changes are visible."""
    assert SHARE_CORRECTION_THRESHOLD == 0.01
