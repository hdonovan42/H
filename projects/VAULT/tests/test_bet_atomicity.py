"""Tests for the two-phase pending→confirm/cancel bet flow.

Regression target: orders filled on-chain but not recorded in the DB
(the "$50 gone without trace" pattern from 15 March 2026).
"""
import pytest

from vault import ledger
from vault.ledger import (
    record_prediction_pending,
    record_prediction_confirm,
    record_prediction_cancel,
    record_prediction_reconciling,
    get_pending_predictions,
    has_pending_predictions,
    get_balance,
    go_live_reset,
)


def _pending(db, **kwargs):
    """Helper: insert a pending real-mode bet with defaults."""
    defaults = dict(
        market_id="mkt_1", condition_id=None, question="Test question?",
        slug=None, side="YES", amount_usd=10.0, odds=0.5,
        clob_token_id="token_1", end_date=None, cycle_id=None,
        entry_edge=None, entry_confidence=None, entry_reasoning="test",
        clob_attempt_id="attempt_abc",
    )
    defaults.update(kwargs)
    return record_prediction_pending(db, **defaults)


def test_pending_insert_writes_no_ledger_entry(seeded_db):
    """Phase 1 must not touch the ledger — USDC hasn't moved yet."""
    go_live_reset(seeded_db, 50.0)
    balance_before = get_balance(seeded_db)
    _pending(seeded_db, amount_usd=10.0)
    assert get_balance(seeded_db) == pytest.approx(balance_before)


def test_pending_row_has_correct_status(seeded_db):
    """Inserted row is status='pending', execution_mode='real'."""
    go_live_reset(seeded_db, 50.0)
    pid = _pending(seeded_db)
    row = seeded_db.execute("SELECT status, execution_mode, pending_since FROM predictions WHERE id = ?", (pid,)).fetchone()
    assert row["status"] == "pending"
    assert row["execution_mode"] == "real"
    assert row["pending_since"] is not None


def test_has_pending_flag(seeded_db):
    """has_pending_predictions flips true/false correctly."""
    go_live_reset(seeded_db, 50.0)
    assert has_pending_predictions(seeded_db) is False
    pid = _pending(seeded_db)
    assert has_pending_predictions(seeded_db) is True
    record_prediction_cancel(seeded_db, pid, "test")
    assert has_pending_predictions(seeded_db) is False


def test_confirm_transitions_and_debits(seeded_db):
    """Confirm flips status → open and deducts fill_amount_usd from balance atomically."""
    go_live_reset(seeded_db, 50.0)
    pid = _pending(seeded_db, amount_usd=10.0)
    balance_before = get_balance(seeded_db)

    new_balance = record_prediction_confirm(
        seeded_db, pid,
        fill_amount_usd=9.50,  # partial fill at better price
        fill_shares=19.0,
        fill_odds=0.5,
        fill_verified=True,
    )

    # Balance deducted exactly what CLOB actually spent, not the pending estimate
    assert new_balance == pytest.approx(balance_before - 9.50)

    row = seeded_db.execute(
        "SELECT status, cost_basis, shares, fill_verified_at FROM predictions WHERE id = ?",
        (pid,)
    ).fetchone()
    assert row["status"] == "open"
    assert row["cost_basis"] == pytest.approx(9.50)
    assert row["shares"] == pytest.approx(19.0)
    assert row["fill_verified_at"] is not None


def test_cancel_leaves_balance_untouched(seeded_db):
    """Cancel writes no ledger entry — USDC never moved."""
    go_live_reset(seeded_db, 50.0)
    balance_before = get_balance(seeded_db)
    pid = _pending(seeded_db, amount_usd=10.0)
    record_prediction_cancel(seeded_db, pid, "CLOB rejected")
    assert get_balance(seeded_db) == pytest.approx(balance_before)

    row = seeded_db.execute("SELECT status, resolution FROM predictions WHERE id = ?", (pid,)).fetchone()
    assert row["status"] == "cancelled"
    assert row["resolution"] == "cancelled"


def test_confirm_refuses_non_pending(seeded_db):
    """Confirming an already-confirmed or cancelled row must raise — not silently double-debit."""
    go_live_reset(seeded_db, 50.0)
    pid = _pending(seeded_db, amount_usd=10.0)
    record_prediction_confirm(seeded_db, pid, fill_amount_usd=10.0, fill_shares=20.0, fill_odds=0.5)

    with pytest.raises(ValueError, match="not 'pending'"):
        record_prediction_confirm(seeded_db, pid, fill_amount_usd=10.0, fill_shares=20.0, fill_odds=0.5)


def test_cancel_refuses_non_pending(seeded_db):
    """Cancelling a non-pending row raises — prevents hiding real positions."""
    go_live_reset(seeded_db, 50.0)
    pid = _pending(seeded_db)
    record_prediction_confirm(seeded_db, pid, fill_amount_usd=10.0, fill_shares=20.0, fill_odds=0.5)

    with pytest.raises(ValueError, match="can only cancel pending"):
        record_prediction_cancel(seeded_db, pid, "late cancel")


def test_reconciling_transition(seeded_db):
    """Reconciling flag preserved with reason; event row written."""
    go_live_reset(seeded_db, 50.0)
    pid = _pending(seeded_db)
    record_prediction_reconciling(seeded_db, pid, "CTF shows unexpected balance")

    row = seeded_db.execute("SELECT status, entry_reasoning FROM predictions WHERE id = ?", (pid,)).fetchone()
    assert row["status"] == "reconciling"
    assert "RECONCILING" in row["entry_reasoning"]

    event = seeded_db.execute("SELECT event, detail FROM events WHERE event = 'reconciling'").fetchone()
    assert event is not None
    assert f"Pred #{pid}" in event["detail"]


def test_atomic_confirm_rolls_back_on_ledger_failure(seeded_db):
    """If the ledger INSERT fails, the prediction status must not flip to 'open'.

    We force the failure via a BEFORE INSERT trigger on the ledger table that
    raises on any `prediction_buy` entry. Because record_prediction_confirm wraps
    the UPDATE + INSERT in a BEGIN IMMEDIATE ... COMMIT block with rollback on
    exception, the prediction row must remain 'pending' after the failure.

    If this test ever fails, it means the atomicity contract is broken: an
    on-chain position could be opened without a corresponding ledger debit —
    the exact 15 March 2026 failure mode.
    """
    go_live_reset(seeded_db, 50.0)
    pid = _pending(seeded_db, amount_usd=10.0)

    seeded_db.executescript("""
        CREATE TRIGGER fail_prediction_buy BEFORE INSERT ON ledger
        WHEN NEW.entry_type = 'prediction_buy'
        BEGIN
            SELECT RAISE(FAIL, 'simulated ledger failure');
        END;
    """)
    seeded_db.commit()

    try:
        with pytest.raises(Exception, match="simulated ledger failure"):
            record_prediction_confirm(
                seeded_db, pid,
                fill_amount_usd=10.0, fill_shares=20.0, fill_odds=0.5,
            )
    finally:
        seeded_db.executescript("DROP TRIGGER fail_prediction_buy")
        seeded_db.commit()

    # Critical assertion: row must still be 'pending'. If 'open', atomicity broken.
    row = seeded_db.execute("SELECT status FROM predictions WHERE id = ?", (pid,)).fetchone()
    assert row["status"] == "pending", \
        "Atomicity violation: prediction flipped to 'open' without a ledger entry"

    # Balance must also be untouched — no partial debit
    assert get_balance(seeded_db) == pytest.approx(50.0)


def test_pending_excluded_from_open_predictions(seeded_db):
    """`get_open_predictions` returns only status='open' — pending rows hide until confirmed."""
    go_live_reset(seeded_db, 50.0)
    _pending(seeded_db)
    assert ledger.get_open_predictions(seeded_db) == []
