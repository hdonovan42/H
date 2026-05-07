"""Tests for the on-chain redemption module."""
from unittest.mock import patch, MagicMock

import pytest

from vault import ledger
from vault.redeem import find_redeemable, redeem_prediction, redemption_sweep


def _seed_closed_real_win(conn, *, pred_id_marker="test", payout=2.29, shares=2.29, side="YES", resolution="won"):
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
            resolution,
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


def test_find_redeemable_excludes_sold_positions(seeded_db):
    """Regression: 1 May 2026 incident. After v20.8.2's SELL stealth fix
    started cleanly closing positions via momentum exit, the
    redemption_sweep kept trying to redeem them anyway. Each sweep found
    only dust (~0.001 shares) on-chain, redeemed it for ~$0.001, then
    wrote redemption_adjustment = actual − payout = roughly −$1.50 against
    the SELL proceeds that had ALREADY been credited via the sell flow.
    7 such phantom adjustments cumulatively poisoned the ledger by
    −$10.56 over 4 days. Fix: skip resolution='sold' (and 'cancelled',
    'failed') — only redeem positions resolved through market settlement."""
    ledger.go_live_reset(seeded_db, 50.0)
    pid_won = _seed_closed_real_win(seeded_db, pred_id_marker="won", resolution="won")
    pid_sold = _seed_closed_real_win(seeded_db, pred_id_marker="sold", resolution="sold")
    pid_cancelled = _seed_closed_real_win(seeded_db, pred_id_marker="cancelled", resolution="cancelled")
    pid_failed = _seed_closed_real_win(seeded_db, pred_id_marker="failed", resolution="failed")
    pid_null = _seed_closed_real_win(seeded_db, pred_id_marker="null", resolution=None)

    # All have on-chain dust shares
    with patch("vault.redeem.get_ctf_balance", return_value=0.005):
        out = find_redeemable(seeded_db)

    ids = {r["id"] for r in out}
    assert pid_won in ids, "won positions are redeemable"
    assert pid_null in ids, "null resolution treated as redeemable (UMA-pending wins)"
    assert pid_sold not in ids, "SELL proceeds already credited; don't double-account via redeem"
    assert pid_cancelled not in ids
    assert pid_failed not in ids
