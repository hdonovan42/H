"""Tests for the on-chain redemption module."""
from unittest.mock import patch, MagicMock

import pytest

from vault import ledger
from vault.redeem import find_redeemable, redeem_prediction, redemption_sweep


def _seed_closed_real_win(conn, *, pred_id_marker="test", payout=2.29, shares=2.29, side="YES"):
    """Insert a closed real-mode winning prediction directly. Returns the row's id."""
    cur = conn.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, "
        "shares, entry_odds, cost_basis, clob_token_id, end_date, status, "
        "execution_mode, payout, pnl, opened_at, closed_at, resolution) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            f"mkt_{pred_id_marker}",
            "0x" + "ab" * 32,
            f"Test market {pred_id_marker}?",
            f"test-{pred_id_marker}",
            side,
            shares,
            0.5,
            shares * 0.5,
            f"token_{pred_id_marker}",
            "2026-12-31T00:00:00Z",
            "closed",
            "real",
            payout,
            payout - (shares * 0.5),
            "2026-04-25T00:00:00Z",
            "2026-04-26T00:00:00Z",
            "won",
        ),
    )
    conn.commit()
    return cur.lastrowid


def test_find_redeemable_only_returns_positions_with_onchain_shares(seeded_db):
    """Closed wins where CTF balance > 0 are redeemable; balance == 0 means
    already redeemed."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid_unredeemed = _seed_closed_real_win(seeded_db, pred_id_marker="A")
    pid_redeemed = _seed_closed_real_win(seeded_db, pred_id_marker="B")

    # Mock on-chain CTF: A still has shares, B is empty.
    def fake_balance(token_id):
        return 2.29 if "A" in token_id else 0.0

    with patch("vault.redeem.get_ctf_balance", side_effect=fake_balance):
        out = find_redeemable(seeded_db)

    ids = [r["id"] for r in out]
    assert pid_unredeemed in ids
    assert pid_redeemed not in ids


def test_redeem_prediction_skips_when_no_onchain_shares(seeded_db):
    """Idempotent: redeeming an already-redeemed prediction returns success
    with usdc_received=0 and no tx."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _seed_closed_real_win(seeded_db)

    with patch("vault.redeem.get_ctf_balance", return_value=0.0), \
         patch("vault.redeem._is_neg_risk_market", return_value=True):
        result = redeem_prediction(seeded_db, pid)

    assert result["success"] is True
    assert result["usdc_received"] == 0.0
    assert result["tx_hash"] is None


def test_redeem_prediction_refuses_unknown_market_type(seeded_db):
    """If gamma API can't tell us neg-risk vs binary, refuse to send the tx."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _seed_closed_real_win(seeded_db)

    with patch("vault.redeem.get_ctf_balance", return_value=2.29), \
         patch("vault.redeem._is_neg_risk_market", return_value=None):
        result = redeem_prediction(seeded_db, pid)

    assert result["success"] is False
    assert "negRisk" in result["error"]


def test_redeem_prediction_refuses_non_real_or_non_closed(seeded_db):
    """Guards: only closed real-mode predictions are redeemable."""
    ledger.go_live_reset(seeded_db, 50.0)
    # Insert an open real prediction
    cur = seeded_db.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, "
        "shares, entry_odds, cost_basis, clob_token_id, status, execution_mode) "
        "VALUES ('m','0xab','q','s','YES',1,0.5,0.5,'tok','open','real')"
    )
    seeded_db.commit()
    open_pid = cur.lastrowid

    result = redeem_prediction(seeded_db, open_pid)
    assert result["success"] is False
    assert "closed" in result["error"]

    # Now sim mode
    cur = seeded_db.execute(
        "INSERT INTO predictions (market_id, condition_id, question, slug, side, "
        "shares, entry_odds, cost_basis, clob_token_id, status, execution_mode, payout) "
        "VALUES ('m2','0xab','q','s','YES',1,0.5,0.5,'tok','closed','simulated',1)"
    )
    seeded_db.commit()
    sim_pid = cur.lastrowid
    result = redeem_prediction(seeded_db, sim_pid)
    assert result["success"] is False
    assert "real-mode" in result["error"]


def test_redemption_sweep_writes_adjustment_when_actual_differs(seeded_db):
    """When the on-chain redemption returns more or less than the credited
    payout, the sweep writes a redemption_adjustment ledger entry to keep
    cash and wallet in lockstep."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _seed_closed_real_win(seeded_db, payout=2.29, shares=2.29)

    fake_redeem_result = {
        "success": True,
        "tx_hash": "0xfakehash",
        "usdc_received": 2.40,  # got 11¢ more than expected
        "shares_burned": 2.29,
    }

    with patch("vault.redeem.find_redeemable", return_value=[
        {"id": pid, "market_id": "x", "side": "YES", "shares": 2.29, "expected_payout": 2.29}
    ]), patch("vault.redeem.redeem_prediction", return_value=fake_redeem_result):
        summary = redemption_sweep(seeded_db)

    assert summary["redeemed"] == 1
    adj = seeded_db.execute(
        "SELECT amount, description FROM ledger WHERE entry_type = 'redemption_adjustment' "
        "AND reference_id = ?", (pid,)
    ).fetchone()
    assert adj is not None
    assert adj["amount"] == pytest.approx(0.11, abs=1e-3)


def test_redemption_sweep_no_adjustment_when_actual_matches(seeded_db):
    """When actual == expected, no adjustment entry is needed."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid = _seed_closed_real_win(seeded_db, payout=2.29, shares=2.29)

    fake_redeem_result = {
        "success": True,
        "tx_hash": "0xfakehash",
        "usdc_received": 2.29,
        "shares_burned": 2.29,
    }

    with patch("vault.redeem.find_redeemable", return_value=[
        {"id": pid, "market_id": "x", "side": "YES", "shares": 2.29, "expected_payout": 2.29}
    ]), patch("vault.redeem.redeem_prediction", return_value=fake_redeem_result):
        redemption_sweep(seeded_db)

    adj = seeded_db.execute(
        "SELECT 1 FROM ledger WHERE entry_type = 'redemption_adjustment' "
        "AND reference_id = ?", (pid,)
    ).fetchone()
    assert adj is None


def test_redemption_sweep_keeps_going_after_individual_failure(seeded_db):
    """A bad redemption shouldn't block subsequent ones."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid_a = _seed_closed_real_win(seeded_db, pred_id_marker="A")
    pid_b = _seed_closed_real_win(seeded_db, pred_id_marker="B")

    def flaky_redeem(conn, pid, **kwargs):
        if pid == pid_a:
            return {"success": False, "error": "RPC blew up"}
        return {"success": True, "tx_hash": "0xok", "usdc_received": 2.29, "shares_burned": 2.29}

    with patch("vault.redeem.find_redeemable", return_value=[
        {"id": pid_a, "market_id": "x", "side": "YES", "shares": 2.29, "expected_payout": 2.29},
        {"id": pid_b, "market_id": "y", "side": "YES", "shares": 2.29, "expected_payout": 2.29},
    ]), patch("vault.redeem.redeem_prediction", side_effect=flaky_redeem):
        summary = redemption_sweep(seeded_db)

    assert summary["redeemed"] == 1
    assert summary["failed"] == 1
